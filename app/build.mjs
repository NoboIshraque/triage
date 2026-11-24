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
//   package  gulp vscode-<platform>-<arch>-min, written to app/VSCode-<platform>-<arch>/
//
// Never edit app/upstream by hand: prepare resets it. Put changes in app/.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fetchUpstream } from '../scripts/forks/fetch.mjs';
import { ForkError, git, isWindows, main, run, withRetries } from '../scripts/forks/lib.mjs';

const appDir = import.meta.dirname;
const upstreamDir = path.join(appDir, 'upstream');
const STEPS = ['fetch', 'prepare', 'install', 'package'];
/** Folders in app/ whose files replace or add files at the same path in upstream. */
const OVERLAY_ROOTS = ['src', 'resources'];

function parseArgs(argv) {
  const options = { steps: [], arch: process.arch, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--arch') options.arch = argv[++i] ?? '';
    else if (STEPS.includes(arg)) options.steps.push(arg);
    else if (arg === 'all') options.steps.push(...STEPS);
    else throw new ForkError(`unknown argument '${arg}'. Steps: ${STEPS.join(', ')}, all`);
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

function patchFiles() {
  const dir = path.join(appDir, 'patches');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Files that prepare itself writes; anything else changed in upstream is unexpected. */
function managedFiles() {
  const files = new Set(['product.json', ...overlayFiles()]);
  for (const patch of patchFiles()) {
    const names = git(upstreamDir, ['apply', '--numstat', '-z', patch]).split('\0');
    for (const line of names) {
      const name = line.split('\t')[2];
      if (name) files.add(name);
    }
  }
  return files;
}

function prepare({ force }) {
  fetchUpstream(appDir);
  const managed = managedFiles();
  const changed = [
    ...git(upstreamDir, ['diff', '--name-only', 'HEAD']).split('\n'),
    ...git(upstreamDir, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean);
  const unexpected = changed.filter((file) => !managed.has(file));
  if (unexpected.length > 0 && !force) {
    throw new ForkError(
      `app/upstream has changes that prepare did not make:\n  ${unexpected.join('\n  ')}\n` +
        'Move them into app/ (overlay or patch), or re-run with --force to discard them.',
    );
  }

  // Back to the pinned commit; ignored files (node_modules, out/, .build/) stay.
  git(upstreamDir, ['reset', '--quiet', '--hard', 'HEAD']);
  git(upstreamDir, ['clean', '--quiet', '-d', '--force']);

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

  const patches = patchFiles();
  for (const patch of patches) {
    git(upstreamDir, ['apply', '--whitespace=nowarn', patch]);
  }
  console.log(
    `Prepared app/upstream: product.json (${Object.keys(overrides).filter((k) => !k.startsWith('$')).length} keys), ` +
      `${files.length} overlay file(s), ${patches.length} patch(es).`,
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

export function packagedApp(arch = process.arch) {
  const platform = isWindows ? 'win32' : process.platform;
  const folder = path.join(appDir, `VSCode-${platform}-${arch}`);
  const product = JSON.parse(readFileSync(path.join(appDir, 'product.json'), 'utf8'));
  const executable = isWindows
    ? path.join(folder, `${product.nameShort}.exe`)
    : path.join(folder, product.applicationName);
  return { platform, folder, executable };
}

function packageApp({ arch }) {
  const { platform, executable } = packagedApp(arch);
  if (platform !== 'linux' && platform !== 'win32') {
    throw new ForkError(`packaging on ${platform} is not set up yet (macOS joins in P8)`);
  }
  pnpm(['run', 'gulp', `vscode-${platform}-${arch}-min`]);
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
      if (step === 'package') packageApp(options);
    }
  });
}
