#!/usr/bin/env node
// Builds Triage's CAD engine from the pinned FreeCAD release (ROADMAP P2-1): FreeCAD's
// App layer only (no GUI, ADR 0002). One implementation for Linux (GCC, Ubuntu's
// libraries) and Windows (MSVC, FreeCAD's LibPack).
//
//   node engines/cad/build.mjs                    fetch, prepare, configure, build, stage
//   node engines/cad/build.mjs configure build    just those steps, in order
//   node engines/cad/build.mjs test               FreeCAD's Part, Sketcher and PartDesign
//                                                 tests through the staged FreeCADCmd
//
// Steps:
//   fetch      check out engines/cad/upstream.json's pinned commit into upstream/
//   prepare    reset upstream/ to that commit and apply patches/ (GUIDELINES §6)
//   configure  CMake + Ninja in build/<os>/ with the modules Triage uses (MODULES).
//              On Windows FREECAD_LIBPACK_DIR must name FreeCAD's LibPack
//              (scripts/dev/setup.ps1 -Cad), and this must run in a Visual Studio
//              developer shell
//   build      FreeCADCmd and the modules' libraries
//   stage      install into build/<os>/stage/ (bin/, lib/, Mod/, Ext/, data/) and add
//              Triage's engine host (triage/engine/ as stage/triage/): one relocatable
//              folder, which the app ships as resources/app/engines/cad/
//
// Commands:
//   test [--update]                    tests/run.mjs: the module tests, against the golden
//   refresh-patches [--new NNNN-name]  turn edits in upstream/ into patches/
//   check-patches                      apply every patch onto a fresh checkout
//
// Options: --ccache (compiler cache), --debug, --jobs N.
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fetchUpstream } from '../../scripts/forks/fetch.mjs';
import { ForkError, isWindows, main, run } from '../../scripts/forks/lib.mjs';
import {
  applyPatches,
  checkPatches,
  refreshPatches,
  resetUpstream,
} from '../../scripts/forks/patches.mjs';
import { buildDir, stagedEngineDir, stageDir, stagedProgram } from './stage.mjs';

const cadDir = import.meta.dirname;
const upstreamDir = path.join(cadDir, 'upstream');
const engineDir = path.join(cadDir, 'triage', 'engine');

const STEPS = ['fetch', 'prepare', 'configure', 'build', 'stage'];
const COMMANDS = ['test', 'refresh-patches', 'check-patches'];

/**
 * FreeCAD's modules (BUILD_<NAME>) the CAD engine needs in P2: shapes (Part, on
 * OCCT), sketches with their solver, feature modeling, STEP/IGES with colors
 * (Import), measurements, meshes for STL and 3MF, materials (Part needs them) and
 * FreeCAD's test runner. Every other module is off; DEVIATIONS.md says why.
 */
export const MODULES = [
  'PART',
  'MATERIAL',
  'SKETCHER',
  'PART_DESIGN',
  'IMPORT',
  'MEASURE',
  'MESH',
  'TEST',
];

/** FreeCAD modules that are on by default and not used by the engine (yet). */
const MODULES_OFF = [
  'ADDONMGR',
  'ASSEMBLY', // P6: needs Spreadsheet, which needs Draft and TechDraw
  'BIM',
  'CAM',
  'CLOUD',
  'DRAFT',
  'DRAWING',
  'FEM', // P7: needs SMESH and VTK
  'FEM_NETGEN',
  'FLAT_MESH',
  'HELP',
  'IDF',
  'INSPECTION',
  'JTREADER',
  'MATERIAL_EXTERNAL',
  'MESH_PART', // needs SMESH and VTK
  'OPENSCAD',
  'PLOT',
  'POINTS',
  'REVERSEENGINEERING',
  'ROBOT',
  'SANDBOX',
  'SHOW',
  'SPREADSHEET',
  'START',
  'SURFACE',
  'TECHDRAW',
  'TEMPLATE',
  'TUX',
  'VR',
  'WEB',
];

/** FreeCAD options for an engine build (DEVIATIONS.md lists why each differs). */
export function cmakeOptions({ ccache, debug }) {
  const options = {
    CMAKE_BUILD_TYPE: debug ? 'Debug' : 'Release',
    CMAKE_INSTALL_PREFIX: stageDir.split(path.sep).join('/'),
    // The engine has no windows: no Qt widgets, Coin3D or Python Qt bindings.
    BUILD_GUI: 'OFF',
    FREECAD_QT_VERSION: '6',
    // FreeCAD's C++ unit tests (Google Test); the Python module tests run instead.
    ENABLE_DEVELOPER_TESTS: 'OFF',
    // A relocatable folder: FreeCAD's Python package stays beside the engine.
    INSTALL_TO_SITEPACKAGES: 'OFF',
    FREECAD_USE_PCL: 'OFF',
    FREECAD_USE_CCACHE: ccache ? 'ON' : 'OFF',
    // A compiler cache can't reuse precompiled headers across machines.
    FREECAD_USE_PCH: ccache ? 'OFF' : 'ON',
    FREECAD_RELEASE_PDB: 'OFF',
    // FreeCAD 1.1's CMake files still name policies older than CMake 4 accepts.
    CMAKE_POLICY_VERSION_MINIMUM: '3.5',
  };
  for (const name of MODULES) options[`BUILD_${name}`] = 'ON';
  for (const name of MODULES_OFF) options[`BUILD_${name}`] = 'OFF';
  const python = enginePython();
  if (python) options.Python3_EXECUTABLE = python;
  if (ccache && process.env.CCACHE_EXE) {
    // A specific ccache (setup.ps1 -Cad skips Strawberry Perl's old one). FreeCAD
    // also switches MSVC's debug info to /Z7 when it has one, which ccache can cache.
    options.CCACHE_PROGRAM = process.env.CCACHE_EXE.split(path.sep).join('/');
  }
  if (isWindows) {
    // Ninja runs one compile per file already; /MP only gets in ccache's way.
    options.FREECAD_USE_MP_COMPILE_FLAG = 'OFF';
    const libpack = process.env.FREECAD_LIBPACK_DIR;
    if (!libpack)
      throw new ForkError(
        "set FREECAD_LIBPACK_DIR to FreeCAD's LibPack (scripts/dev/setup.ps1 -Cad sets it up)",
      );
    options.FREECAD_LIBPACK_DIR = libpack.split(path.sep).join('/');
    // The LibPack's DLLs (Python, Qt, OCCT …) next to FreeCADCmd, so the staged
    // folder runs on its own.
    options.FREECAD_COPY_DEPEND_DIRS_TO_BUILD = 'ON';
    options.FREECAD_COPY_LIBPACK_BIN_TO_BUILD = 'ON';
    options.FREECAD_COPY_PLUGINS_BIN_TO_BUILD = 'ON';
  }
  return options;
}

/**
 * The Python the engine embeds. TRIAGE_CAD_PYTHON chooses one; on Linux the default
 * is the distribution's own (the one python3-dev installs headers for, named by
 * /usr/bin/python3-config), not whichever python3 comes first on PATH. Windows: the
 * LibPack's Python, which FreeCAD's CMake finds itself.
 */
function enginePython() {
  if (process.env.TRIAGE_CAD_PYTHON) return process.env.TRIAGE_CAD_PYTHON;
  if (isWindows) return undefined;
  const config = '/usr/bin/python3-config';
  if (!existsSync(config)) return undefined;
  const name = path.basename(realpathSync(config)).match(/^(?:.*-)?(python3\.\d+)-config$/);
  return name ? `/usr/bin/${name[1]}` : undefined;
}

function parseArgs(argv) {
  const options = {
    steps: [],
    ccache: false,
    debug: false,
    jobs: undefined,
    update: false,
    newPatch: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ccache') options.ccache = true;
    else if (arg === '--debug') options.debug = true;
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
  fetchUpstream(cadDir);
  resetUpstream(upstreamDir);
  const patches = applyPatches(cadDir);
  console.log(`Prepared engines/cad/upstream: ${patches.length} patch(es).`);
}

function configure(options) {
  if (!existsSync(path.join(upstreamDir, 'CMakeLists.txt')))
    throw new ForkError('run fetch and prepare first');
  mkdirSync(buildDir, { recursive: true });
  const defines = Object.entries(cmakeOptions(options)).map(([key, value]) => `-D${key}=${value}`);
  run('cmake', ['-G', 'Ninja', '-S', upstreamDir, '-B', buildDir, ...defines]);
}

function build(options) {
  const jobs = options.jobs ?? Math.max(1, os.availableParallelism());
  run('cmake', ['--build', buildDir, '--parallel', String(jobs)]);
}

function stage() {
  rmSync(stageDir, { recursive: true, force: true });
  run('cmake', ['--install', buildDir]);
  if (!existsSync(stagedProgram('FreeCADCmd'))) {
    throw new ForkError(`FreeCADCmd was not installed into ${stageDir}`);
  }
  // Triage's engine host (P2-2), which FreeCADCmd runs: stage/triage/.
  cpSync(engineDir, stagedEngineDir, {
    recursive: true,
    filter: (source) => !source.includes('__pycache__'),
  });
  console.log(`Staged FreeCAD and Triage's engine in ${path.relative(process.cwd(), stageDir)}.`);
}

async function test(options) {
  const { runModuleTests } = await import('./tests/run.mjs');
  await runModuleTests({ update: options.update });
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
    fetch: () => fetchUpstream(cadDir),
    prepare,
    configure: () => configure(options),
    build: () => build(options),
    stage,
    'refresh-patches': () => {
      const { written, deleted } = refreshPatches(cadDir, { newPatch: options.newPatch });
      console.log(
        `Patches written: ${written.join(', ') || 'none'}; deleted: ${deleted.join(', ') || 'none'}.`,
      );
    },
    'check-patches': () =>
      console.log(`All ${checkPatches(cadDir).length} patch(es) apply cleanly.`),
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
