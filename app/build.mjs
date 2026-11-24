#!/usr/bin/env node
// Builds Triage's desktop app from the pinned VS Code release (ROADMAP P0-2).
// One implementation for both systems: app/build.sh (Linux) and app/build.ps1
// (Windows) only start this script.
//
//   node app/build.mjs                  # fetch, prepare, install, package
//   node app/build.mjs prepare          # just the listed steps, in order
//   node app/build.mjs --arch arm64     # another CPU (default: this machine's)
//   node app/build.mjs prepare --force  # discard unexpected edits in app/upstream
//
// Steps:
//   fetch    check out app/upstream.json's pinned commit into app/upstream/
//   prepare  reset app/upstream to that commit, then apply Triage's changes:
//            product.json keys, files mirrored from app/ (src/, resources/),
//            and patches from app/patches/ (P0-3)
//   install  pnpm install in app/upstream (pnpm version pinned by upstream)
//   typecheck  type-check Triage's workbench code (src/tsconfig.triage.json); the
//            package step transpiles with esbuild, which doesn't check types
//   package  gulp vscode-<platform>-<arch> (add --min for the minified, mangled
//            bundle, which needs more memory than 8 GB CI runners have), written
//            to app/VSCode-<platform>-<arch>/
//
//   engines  build Triage's native engines (CMake preset "release") and the Rust
//            model addon, and copy them into the packaged app (resources/app/
//            engines/); on Windows, run from a Visual Studio developer shell
//
// Patch commands (P0-3):
//   refresh-patches [--new NNNN-name]  turn edits in app/upstream into app/patches/
//   check-patches                      apply every patch onto a fresh checkout
//
// Changing upstream: edit app/upstream, then refresh-patches. prepare refuses to
// discard edits made since the last prepare (unless --force).
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fetchUpstream } from '../scripts/forks/fetch.mjs';
import {
  ForkError,
  git,
  isWindows,
  main,
  repoRoot,
  run,
  withRetries,
} from '../scripts/forks/lib.mjs';
import {
  applyPatches,
  checkPatches,
  patchOwners,
  refreshPatches,
  resetUpstream,
} from '../scripts/forks/patches.mjs';

const appDir = import.meta.dirname;
const upstreamDir = path.join(appDir, 'upstream');
const STEPS = ['fetch', 'prepare', 'install', 'typecheck', 'package', 'engines'];
const COMMANDS = ['refresh-patches', 'check-patches'];
/** Folders in app/ whose files replace or add files at the same path in upstream. */
const OVERLAY_ROOTS = ['src', 'resources'];

function parseArgs(argv) {
  const options = { steps: [], arch: process.arch, force: false, min: false, newPatch: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--min') options.min = true;
    else if (arg === '--arch') options.arch = argv[++i] ?? '';
    else if (arg === '--new') options.newPatch = argv[++i] ?? '';
    else if (STEPS.includes(arg) || COMMANDS.includes(arg)) options.steps.push(arg);
    else if (arg === 'all') options.steps.push(...STEPS);
    else {
      throw new ForkError(
        `unknown argument '${arg}'. Steps: ${STEPS.join(', ')}, all. Commands: ${COMMANDS.join(', ')}`,
      );
    }
  }
  if (options.steps.length === 0) options.steps = [...STEPS];
  if (!['x64', 'arm64'].includes(options.arch)) {
    throw new ForkError(`unsupported --arch '${options.arch}' (x64 or arm64)`);
  }
  return options;
}

/** Relative paths (with forward slashes) of every file under app/<root>. */
function overlayFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(appDir, full).split(path.sep).join('/'));
    }
  };
  for (const root of OVERLAY_ROOTS) {
    const dir = path.join(appDir, root);
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  }
  return files.sort();
}

// prepare remembers the tree it produced (a git tree hash of the checkout,
// built in a private index so upstream's own index is untouched). The next
// prepare compares the checkout with it, so hand edits are never lost silently.
const stampFile = () => path.join(upstreamDir, '.git', 'triage-prepared-tree');

function checkoutTree() {
  const env = { GIT_INDEX_FILE: path.join(upstreamDir, '.git', 'triage-index') };
  if (!existsSync(env.GIT_INDEX_FILE)) git(upstreamDir, ['read-tree', 'HEAD'], { env });
  git(upstreamDir, ['add', '--all'], { env });
  return git(upstreamDir, ['write-tree'], { env });
}

function editsSincePrepare() {
  // The stamp is "<commit> <tree>"; after a re-pin it no longer applies.
  const head = git(upstreamDir, ['rev-parse', 'HEAD']);
  const [commit, tree] = existsSync(stampFile())
    ? readFileSync(stampFile(), 'utf8').trim().split(' ')
    : [];
  const expected = commit === head && tree ? tree : git(upstreamDir, ['rev-parse', 'HEAD^{tree}']);
  const actual = checkoutTree();
  if (actual === expected) return [];
  return git(upstreamDir, ['diff-tree', '-r', '--name-only', expected, actual])
    .split('\n')
    .filter(Boolean);
}

function rememberPreparedTree() {
  writeFileSync(stampFile(), `${git(upstreamDir, ['rev-parse', 'HEAD'])} ${checkoutTree()}\n`);
}

/** Paths prepare writes itself; patches must not touch them. */
function generatedFiles() {
  return new Set(['product.json', ...overlayFiles()]);
}

function prepare({ force }) {
  fetchUpstream(appDir);
  const edits = editsSincePrepare();
  if (edits.length > 0 && !force) {
    throw new ForkError(
      `app/upstream was edited since the last prepare:\n  ${edits.join('\n  ')}\n` +
        'Keep the edits with `node app/build.mjs refresh-patches [--new NNNN-name]`, ' +
        'or re-run prepare with --force to discard them.',
    );
  }

  // Back to the pinned commit; ignored files (node_modules, out/, .build/) stay.
  resetUpstream(upstreamDir);

  const product = JSON.parse(git(upstreamDir, ['show', 'HEAD:product.json']));
  const overrides = JSON.parse(readFileSync(path.join(appDir, 'product.json'), 'utf8'));
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('$')) continue;
    if (value === null) delete product[key];
    else product[key] = value;
  }
  writeFileSync(path.join(upstreamDir, 'product.json'), `${JSON.stringify(product, null, '\t')}\n`);

  const files = overlayFiles();
  for (const file of files) {
    cpSync(path.join(appDir, file), path.join(upstreamDir, file));
  }

  const generated = generatedFiles();
  const clash = [...patchOwners(appDir).keys()].filter((file) => generated.has(file));
  if (clash.length > 0) {
    throw new ForkError(`patches must not change files that prepare writes: ${clash.join(', ')}`);
  }
  const patches = applyPatches(appDir);
  rememberPreparedTree();
  console.log(
    `Prepared app/upstream: product.json (${Object.keys(overrides).filter((k) => !k.startsWith('$')).length} keys), ` +
      `${files.length} overlay file(s), ${patches.length} patch(es).`,
  );
}

function refreshAppPatches({ newPatch }) {
  const { written, deleted } = refreshPatches(appDir, { exclude: generatedFiles(), newPatch });
  rememberPreparedTree();
  console.log(
    `Patches written: ${written.join(', ') || 'none'}; deleted: ${deleted.join(', ') || 'none'}.`,
  );
}

/** Upstream pins its pnpm version in package.json; corepack runs exactly that one. */
function pnpm(args, env = {}) {
  run('corepack', ['pnpm', ...args], {
    cwd: upstreamDir,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_STRICT: '0', ...env },
  });
}

function install() {
  if (!existsSync(path.join(upstreamDir, '.git'))) throw new ForkError('run the fetch step first');
  withRetries('pnpm install', () =>
    pnpm(['install', '--frozen-lockfile'], {
      // The package step downloads Electron itself; tests here need no browsers.
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    }),
  );
}

function typecheck() {
  const tsc = path.join(upstreamDir, 'node_modules', 'typescript', 'bin', 'tsc6');
  if (!existsSync(tsc)) throw new ForkError('run the install step first');
  run(process.execPath, [tsc, '-p', path.join('src', 'tsconfig.triage.json')], {
    cwd: upstreamDir,
  });
  console.log("Triage's workbench code type-checks.");
}

/** Native engines that ship inside the app, built by the root CMakeLists.txt. */
const ENGINES = [path.join('engines', 'hello', 'triage-hello-engine')];

function buildEngines({ arch }) {
  const { folder } = packagedApp(arch);
  if (!existsSync(folder)) throw new ForkError('run the package step first');
  run('cmake', ['--workflow', '--preset', 'release'], { cwd: repoRoot });
  // The Rust project model as a Node addon, for the model service (P0-5).
  run(process.execPath, [path.join(repoRoot, 'crates', 'triage-model-node', 'build.mjs')], {
    cwd: repoRoot,
  });
  const target = path.join(folder, 'resources', 'app', 'engines');
  mkdirSync(target, { recursive: true });
  const files = [
    ...ENGINES.map((engine) =>
      path.join('build', 'native', 'release', `${engine}${isWindows ? '.exe' : ''}`),
    ),
    path.join('build', 'native', 'addons', 'triage_model.node'),
  ];
  for (const file of files) {
    cpSync(path.join(repoRoot, file), path.join(target, path.basename(file)));
    console.log(`Copied ${path.basename(file)} into ${path.relative(process.cwd(), target)}`);
  }
}

export function packagedApp(arch = process.arch) {
  const platform = isWindows ? 'win32' : process.platform;
  const folder = path.join(appDir, `VSCode-${platform}-${arch}`);
  const product = JSON.parse(readFileSync(path.join(appDir, 'product.json'), 'utf8'));
  const executable = isWindows
    ? path.join(folder, `${product.nameShort}.exe`)
    : path.join(folder, product.applicationName);
  return { platform, folder, executable };
}

function packageApp({ arch, min }) {
  const { platform, executable } = packagedApp(arch);
  if (platform !== 'linux' && platform !== 'win32') {
    throw new ForkError(`packaging on ${platform} is not set up yet (macOS joins in P8)`);
  }
  pnpm(['run', 'gulp', `vscode-${platform}-${arch}${min ? '-min' : ''}`]);
  if (!existsSync(executable)) {
    throw new ForkError(`packaging finished but ${executable} is missing`);
  }
  console.log(`Built ${path.relative(process.cwd(), executable)}`);
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  main(() => {
    const options = parseArgs(process.argv.slice(2));
    for (const step of options.steps) {
      console.log(`\n== ${step}`);
      if (step === 'fetch') fetchUpstream(appDir, { force: options.force });
      if (step === 'prepare') prepare(options);
      if (step === 'install') install();
      if (step === 'typecheck') typecheck();
      if (step === 'package') packageApp(options);
      if (step === 'engines') buildEngines(options);
      if (step === 'refresh-patches') refreshAppPatches(options);
      if (step === 'check-patches') {
        console.log(
          `${checkPatches(appDir).length} patch(es) apply cleanly onto a fresh checkout.`,
        );
      }
    }
  });
}
