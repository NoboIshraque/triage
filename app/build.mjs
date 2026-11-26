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
//   package  gulp vscode-<platform>-<arch>, written to app/VSCode-<platform>-<arch>/.
//            Bundles one entry point at a time without source maps, to fit 8 GB
//            machines; --sourcemaps keeps upstream's parallel bundling and maps,
//            --min the minified, mangled bundle (both need more memory)
//
//   engines  build Triage's native engines (CMake preset "release") and the Rust
//            model addon, and copy them into the packaged app (resources/app/
//            engines/); on Windows, run from a Visual Studio developer shell
//
//   dist     (not run by default) archives for testers in app/.dist/ (P0-7): on
//            Windows a portable zip and the per-user installer (VS Code's Inno
//            Setup build), on Linux a .tar.gz
//
// Patch commands (P0-3):
//   refresh-patches [--new NNNN-name]  turn edits in app/upstream into app/patches/
//   check-patches                      apply every patch onto a fresh checkout
//
// Changing upstream: edit app/upstream, then refresh-patches. prepare refuses to
// discard edits made since the last prepare (unless --force).
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { rebrandPackagedApp } from '../scripts/branding/rebrand.mjs';
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
/** Not part of the default steps: run after the smoke test passes. */
const EXTRA_STEPS = ['dist'];
const COMMANDS = ['refresh-patches', 'check-patches'];
/** Folders in app/ whose files replace or add files at the same path in upstream. */
const OVERLAY_ROOTS = ['src', 'resources'];

function parseArgs(argv) {
  const options = {
    steps: [],
    arch: process.arch,
    force: false,
    min: false,
    sourcemaps: false,
    newPatch: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--min') options.min = true;
    else if (arg === '--sourcemaps') options.sourcemaps = true;
    else if (arg === '--arch') options.arch = argv[++i] ?? '';
    else if (arg === '--new') options.newPatch = argv[++i] ?? '';
    else if (STEPS.includes(arg) || EXTRA_STEPS.includes(arg) || COMMANDS.includes(arg))
      options.steps.push(arg);
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
  // The EDA engine (KiCad's engine, ROADMAP P1-2), staged by engines/eda/build.mjs
  // or downloaded from the EDA workflow: programs, kifaces and libraries in one folder.
  const edaStage = path.join(
    repoRoot,
    'engines',
    'eda',
    'build',
    isWindows ? 'windows' : 'linux',
    'stage',
    'bin',
  );
  const edaTarget = path.join(target, 'eda');
  rmSync(edaTarget, { recursive: true, force: true });
  if (existsSync(edaStage)) {
    cpSync(edaStage, edaTarget, { recursive: true });
    if (!isWindows) {
      // Artifacts lose the executable bit.
      for (const name of ['triage-eda-engine', 'kicad-cli', 'eeschema', 'pcbnew']) {
        const file = path.join(edaTarget, name);
        if (existsSync(file)) chmodSync(file, 0o755);
      }
    }
    console.log(
      `Copied the EDA engine (${readdirSync(edaTarget).length} files) into ${path.relative(process.cwd(), edaTarget)}`,
    );
  } else {
    console.log(
      `No EDA engine in ${path.relative(process.cwd(), edaStage)}: the Schematic and Board tabs will say so.`,
    );
  }
  // The CAD engine (FreeCAD's App layer and Triage's engine host, ROADMAP P2-2),
  // staged by engines/cad/build.mjs or downloaded from the CAD workflow.
  const cadStage = path.join(
    repoRoot,
    'engines',
    'cad',
    'build',
    isWindows ? 'windows' : 'linux',
    'stage',
  );
  const cadTarget = path.join(target, 'cad');
  rmSync(cadTarget, { recursive: true, force: true });
  if (existsSync(cadStage)) {
    cpSync(cadStage, cadTarget, { recursive: true, verbatimSymlinks: true });
    if (!isWindows) {
      // Artifacts lose the executable bit.
      const freecad = path.join(cadTarget, 'bin', 'FreeCADCmd');
      if (existsSync(freecad)) chmodSync(freecad, 0o755);
    }
    console.log(`Copied the CAD engine into ${path.relative(process.cwd(), cadTarget)}`);
  } else {
    console.log(
      `No CAD engine in ${path.relative(process.cwd(), cadStage)}: the 3D tab will say so.`,
    );
  }
}

function dist({ arch }) {
  const { platform, folder } = packagedApp(arch);
  if (!existsSync(folder)) throw new ForkError('run the package step first');
  const out = path.join(appDir, '.dist');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { nameShort } = JSON.parse(readFileSync(path.join(appDir, 'product.json'), 'utf8'));
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const stamp = `${date}-${git(repoRoot, ['rev-parse', '--short=8', 'HEAD'])}`;

  if (platform === 'win32') {
    // The updater the installer needs, then VS Code's own Inno Setup build.
    pnpm(['run', 'gulp', `vscode-win32-${arch}-inno-updater`]);
    pnpm(['run', 'gulp', `vscode-win32-${arch}-user-setup`]);
    const setup = path.join(
      upstreamDir,
      '.build',
      `win32-${arch}`,
      'user-setup',
      'VSCodeSetup.exe',
    );
    cpSync(setup, path.join(out, `${nameShort}UserSetup-${arch}-${stamp}.exe`));
  }
  // Archive the folder under the product's name: rename it for the moment
  // (Windows' bsdtar has no option to rename while archiving).
  const named = path.join(appDir, nameShort);
  if (existsSync(named)) throw new ForkError(`${named} is in the way; remove it`);
  renameSync(folder, named);
  try {
    if (platform === 'win32') {
      // Windows' own tar (bsdtar) writes zip files.
      const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      const zip = path.join(out, `${nameShort}-win32-${arch}-${stamp}.zip`);
      run(tar, ['-a', '-c', '-f', zip, '-C', appDir, nameShort]);
    } else {
      const archive = path.join(out, `${nameShort}-${platform}-${arch}-${stamp}.tar.gz`);
      run('tar', ['-czf', archive, '-C', appDir, nameShort]);
    }
  } finally {
    renameSync(named, folder);
  }
  for (const file of readdirSync(out)) {
    const mib = statSync(path.join(out, file)).size / 2 ** 20;
    console.log(`${path.join('app', '.dist', file)}  ${mib.toFixed(0)} MiB`);
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

function packageApp({ arch, min, sourcemaps }) {
  const { platform, folder, executable } = packagedApp(arch);
  if (platform !== 'linux' && platform !== 'win32') {
    throw new ForkError(`packaging on ${platform} is not set up yet (macOS joins in P8)`);
  }
  // Patches 0002/0003: bundle one entry point at a time, without source maps, so
  // the build fits 8 GB machines (3.7 GB peak instead of more than 7 GB; DV-13).
  const lowMemory = sourcemaps ? {} : { TRIAGE_SEQUENTIAL_BUNDLES: '1', TRIAGE_NO_SOURCEMAPS: '1' };
  pnpm(['run', 'gulp', `vscode-${platform}-${arch}${min ? '-min' : ''}`], lowMemory);
  if (!existsSync(executable)) {
    throw new ForkError(`packaging finished but ${executable} is missing`);
  }
  // ROADMAP P0-9: Microsoft's trademarks don't name Triage in its interface text.
  const { nameShort } = JSON.parse(readFileSync(path.join(appDir, 'product.json'), 'utf8'));
  const rebranded = rebrandPackagedApp(path.join(folder, 'resources', 'app'), nameShort);
  console.log(`Rebranded ${rebranded.strings} interface strings in ${rebranded.files} files`);
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
      if (step === 'dist') dist(options);
      if (step === 'refresh-patches') refreshAppPatches(options);
      if (step === 'check-patches') {
        console.log(
          `${checkPatches(appDir).length} patch(es) apply cleanly onto a fresh checkout.`,
        );
      }
    }
  });
}
