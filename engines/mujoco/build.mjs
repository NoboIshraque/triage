#!/usr/bin/env node
// Builds MuJoCo, the physics engine of Triage's mechanics unit (ROADMAP P3-4,
// PLAN §4.7), from the pinned release in upstream.json. One implementation for
// Linux (GCC) and Windows (MSVC; run it in a Visual Studio developer shell).
//
//   node engines/mujoco/build.mjs            fetch, configure, build, install
//   node engines/mujoco/build.mjs build      just that step (and the ones it needs)
//
// The library is installed into engines/mujoco/build/<os>/install/ (include/,
// lib/, bin/ on Windows). crates/triage-mujoco links to it when the sim addon is
// built with the "mujoco" feature (crates/triage-sim-node/build.mjs --mujoco);
// MuJoCo's own CMake fetches its small dependencies (qhull, tinyxml2, lodepng …)
// as source and builds them into the library.
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fetchUpstream } from '../../scripts/forks/fetch.mjs';
import { ForkError, isWindows, main, run } from '../../scripts/forks/lib.mjs';

const dir = import.meta.dirname;
const upstreamDir = path.join(dir, 'upstream');
const osName = isWindows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
export const buildDir = path.join(dir, 'build', osName);
export const installDir = path.join(buildDir, 'install');

/** The shared library the sim addon loads, relative to installDir. */
export const sharedLibrary = isWindows
  ? path.join('bin', 'mujoco.dll')
  : process.platform === 'darwin'
    ? path.join('lib', 'libmujoco.dylib')
    : path.join('lib', 'libmujoco.so');

const STEPS = ['fetch', 'configure', 'build'];

function configure() {
  const cmakeBuild = path.join(buildDir, 'cmake');
  mkdirSync(cmakeBuild, { recursive: true });
  run('cmake', [
    '-S',
    upstreamDir,
    '-B',
    cmakeBuild,
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${installDir}`,
    // The library only: no samples, viewer, studio or tests.
    '-DMUJOCO_BUILD_EXAMPLES=OFF',
    '-DMUJOCO_BUILD_SIMULATE=OFF',
    '-DMUJOCO_BUILD_STUDIO=OFF',
    '-DMUJOCO_BUILD_TESTS=OFF',
    '-DMUJOCO_TEST_PYTHON_UTIL=OFF',
    '-DMUJOCO_WITH_USD=OFF',
    // A relocatable library: the addon finds it beside itself.
    '-DCMAKE_INSTALL_RPATH=$ORIGIN',
  ]);
}

function build(jobs) {
  const cmakeBuild = path.join(buildDir, 'cmake');
  run('cmake', ['--build', cmakeBuild, '--parallel', String(jobs)]);
  run('cmake', ['--install', cmakeBuild]);
  const library = path.join(installDir, sharedLibrary);
  if (!existsSync(library)) throw new ForkError(`MuJoCo built, but ${library} is missing`);
  console.log(`MuJoCo installed in ${path.relative(process.cwd(), installDir)}`);
}

main(() => {
  const args = process.argv.slice(2);
  const jobsAt = args.indexOf('--jobs');
  const jobs = jobsAt >= 0 ? Number(args[jobsAt + 1]) : Math.max(1, os.availableParallelism());
  const steps = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--jobs');
  for (const step of steps) {
    if (!STEPS.includes(step)) throw new ForkError(`unknown step "${step}" (${STEPS.join(', ')})`);
  }
  const wanted = steps.length > 0 ? steps : STEPS;
  if (wanted.includes('fetch')) fetchUpstream(dir);
  if (wanted.includes('configure') || !existsSync(path.join(buildDir, 'cmake', 'CMakeCache.txt')))
    configure();
  if (wanted.includes('build')) build(jobs);
});
