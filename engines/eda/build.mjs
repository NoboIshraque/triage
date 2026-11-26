#!/usr/bin/env node
// Builds Triage's EDA engine from the pinned KiCad release (ROADMAP P1-1, P1-2).
// One implementation for Linux (GCC) and Windows (MSVC + vcpkg).
//
//   node engines/eda/build.mjs                    fetch, prepare, configure, build, stage
//   node engines/eda/build.mjs configure build    just those steps, in order
//   node engines/eda/build.mjs test               the kicad-demos corpus checks (tests/corpus.mjs)
//
// Steps:
//   fetch      check out engines/eda/upstream.json's pinned commit into upstream/
//   prepare    reset upstream/ to that commit and apply patches/ (GUIDELINES §6)
//   configure  CMake + Ninja in build/<os>/ with Triage's options; KICAD_TRIAGE_DIR
//              adds engines/eda/triage/ (the engine host and the faces it adds to
//              KiCad's kifaces). On Windows the vcpkg toolchain builds KiCad's
//              dependencies from upstream's vcpkg.json (VCPKG_ROOT must be set) and
//              this must run in a Visual Studio developer shell
//   build      the targets Triage uses (TARGETS below)
//   stage      copy the built programs, kifaces and libraries into build/<os>/stage/bin/
//              (one folder: the app ships it as resources/app/engines/eda/)
//
// Commands:
//   test [--update]                    kicad-cli and the engine on every demo project
//   refresh-patches [--new NNNN-name]  turn edits in upstream/ into patches/
//   check-patches                      apply every patch onto a fresh checkout
//
// Options: --ccache (compiler launcher), --debug, --all (every KiCad target, for
// the stock KiCad window the fallback uses), --jobs N.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fetchUpstream } from '../../scripts/forks/fetch.mjs';
import { ForkError, isWindows, main, run } from '../../scripts/forks/lib.mjs';
import { buildDir, stageDir } from './stage.mjs';
import {
  applyPatches,
  checkPatches,
  refreshPatches,
  resetUpstream,
} from '../../scripts/forks/patches.mjs';

const edaDir = import.meta.dirname;
const upstreamDir = path.join(edaDir, 'upstream');
const triageDir = path.join(edaDir, 'triage');

const STEPS = ['fetch', 'prepare', 'configure', 'build', 'stage'];
const COMMANDS = ['test', 'refresh-patches', 'check-patches'];

/** What Triage needs from KiCad: kicad-cli, the two kifaces, their stand-alone
 * editors (the temporary fallback window, ROADMAP P1-7) and the engine host. */
const TARGETS = [
  'kicad-cli',
  'pcbnew_kiface',
  'eeschema_kiface',
  // kicad-cli's ERC asks the footprint-assignment kiface about footprint links.
  'cvpcb_kiface',
  'pcbnew',
  'eeschema',
  'triage-eda-engine',
];

/** KiCad options for an engine build (DEVIATIONS.md lists why each differs). */
function cmakeOptions({ ccache, debug }) {
  const options = {
    CMAKE_BUILD_TYPE: debug ? 'Debug' : 'Release',
    KICAD_TRIAGE_DIR: triageDir.split(path.sep).join('/'),
    // Python plugins draw wx windows, which the engine has none of.
    KICAD_SCRIPTING_WXPYTHON: 'OFF',
    KICAD_BUILD_QA_TESTS: 'OFF',
    KICAD_SPICE_QA: 'OFF',
    KICAD_BUILD_I18N: 'OFF',
    KICAD_UPDATE_CHECK: 'OFF',
    KICAD_INSTALL_DEMOS: 'OFF',
    // pcbnew links the IDF tools' library, so they stay on (explicit: a cache from
    // an older configure may say OFF).
    KICAD_IDF_TOOLS: 'ON',
    // A compiler cache can't reuse precompiled headers across machines.
    KICAD_USE_PCH: ccache ? 'OFF' : 'ON',
  };
  if (ccache) {
    // KiCad's own switch: it adds the launcher, and with MSVC it also switches
    // debug info to /Z7, without which ccache caches nothing (KiCad otherwise
    // forces /Zi; EDA run 12: 1953 of 1953 Windows compiles uncacheable).
    // CCACHE_FOUND pre-sets KiCad's find_program result: CCACHE_EXE names a
    // specific ccache (setup.ps1 -Eda skips Strawberry Perl's old one).
    options.USE_CCACHE = 'ON';
    // KiCad prepends ccache to these: clear what an older configure cached.
    options.CMAKE_C_COMPILER_LAUNCHER = '';
    options.CMAKE_CXX_COMPILER_LAUNCHER = '';
    if (process.env.CCACHE_EXE) {
      options.CCACHE_FOUND = process.env.CCACHE_EXE.split(path.sep).join('/');
    }
  }
  if (isWindows) {
    const vcpkgRoot = process.env.VCPKG_ROOT;
    if (!vcpkgRoot)
      throw new ForkError(
        'set VCPKG_ROOT to a vcpkg checkout (KiCad builds its dependencies with it)',
      );
    options.CMAKE_TOOLCHAIN_FILE = path
      .join(vcpkgRoot, 'scripts', 'buildsystems', 'vcpkg.cmake')
      .split(path.sep)
      .join('/');
    options.VCPKG_TARGET_TRIPLET = 'x64-windows';
    options.KICAD_WIN32_DPI_AWARE = 'ON';
    options.CMAKE_POLICY_DEFAULT_CMP0141 = 'NEW';
  } else {
    options.KICAD_WAYLAND = 'OFF';
  }
  return options;
}

function parseArgs(argv) {
  const options = {
    steps: [],
    ccache: false,
    debug: false,
    all: false,
    jobs: undefined,
    update: false,
    newPatch: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ccache') options.ccache = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--update') options.update = true;
    else if (arg === '--jobs') options.jobs = Number(argv[++i]);
    else if (arg === '--new') options.newPatch = argv[++i] ?? '';
    else if (STEPS.includes(arg) || COMMANDS.includes(arg)) options.steps.push(arg);
    else
      throw new ForkError(
        `unknown argument '${arg}'. Steps: ${STEPS.join(', ')}. Commands: ${COMMANDS.join(', ')}`,
      );
  }
  if (options.steps.length === 0) options.steps = [...STEPS];
  return options;
}

function prepare() {
  fetchUpstream(edaDir);
  resetUpstream(upstreamDir);
  const patches = applyPatches(edaDir);
  console.log(`Prepared engines/eda/upstream: ${patches.length} patch(es).`);
}

function configure(options) {
  if (!existsSync(path.join(upstreamDir, 'CMakeLists.txt')))
    throw new ForkError('run fetch and prepare first');
  mkdirSync(buildDir, { recursive: true });
  const defines = Object.entries(cmakeOptions(options)).map(([key, value]) => `-D${key}=${value}`);
  run('cmake', ['-G', 'Ninja', '-S', upstreamDir, '-B', buildDir, ...defines]);
}

function build(options) {
  const targets = options.all ? [] : ['--target', ...TARGETS];
  const jobs = options.jobs ?? Math.max(1, os.availableParallelism());
  run('cmake', ['--build', buildDir, '--parallel', String(jobs), ...targets]);
}

/** Files a staged engine needs: programs, kifaces and every shared library built. */
function stage() {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const exe = isWindows ? '.exe' : '';
  const wanted = new Set(
    ['kicad-cli', 'triage-eda-engine', 'pcbnew', 'eeschema'].map((name) => `${name}${exe}`),
  );
  const libraryPattern = isWindows ? /\.dll$/i : /\.so(\.\d+)*$/;
  const skip = new Set(['stage', 'vcpkg_installed', 'CMakeFiles', 'qa']);
  let copied = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        (wanted.has(entry.name) ||
          entry.name.endsWith('.kiface') ||
          libraryPattern.test(entry.name))
      ) {
        const target = path.join(stageDir, entry.name);
        if (!existsSync(target)) {
          copyFileSync(full, target);
          copied += 1;
        }
      }
    }
  };
  walk(buildDir);
  if (isWindows) {
    // KiCad's dependencies, built by vcpkg.
    const vcpkgBin = path.join(buildDir, 'vcpkg_installed', 'x64-windows', 'bin');
    if (existsSync(vcpkgBin)) {
      for (const name of readdirSync(vcpkgBin)) {
        if (/\.dll$/i.test(name)) {
          copyFileSync(path.join(vcpkgBin, name), path.join(stageDir, name));
          copied += 1;
        }
      }
    }
  }
  for (const name of wanted) {
    if (!existsSync(path.join(stageDir, name)) && name.startsWith('triage-eda-engine')) {
      throw new ForkError(`${name} was not built`);
    }
  }
  console.log(`Staged ${copied} file(s) in ${path.relative(process.cwd(), stageDir)}.`);
}

async function test(options) {
  const { runCorpus } = await import('./tests/corpus.mjs');
  await runCorpus({ update: options.update });
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const options = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exit(2);
    }
  })();
  const steps = {
    fetch: () => fetchUpstream(edaDir),
    prepare,
    configure: () => configure(options),
    build: () => build(options),
    stage,
    'refresh-patches': () => {
      const { written, deleted } = refreshPatches(edaDir, { newPatch: options.newPatch });
      console.log(
        `Patches written: ${written.join(', ') || 'none'}; deleted: ${deleted.join(', ') || 'none'}.`,
      );
    },
    'check-patches': () =>
      console.log(`All ${checkPatches(edaDir).length} patch(es) apply cleanly.`),
  };
  for (const step of options.steps) {
    if (step === 'test') {
      await test(options).catch((error) => {
        console.error(`error: ${error.message}`);
        process.exit(1);
      });
      continue;
    }
    const started = Date.now();
    main(steps[step]);
    console.log(`${step}: ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
}
