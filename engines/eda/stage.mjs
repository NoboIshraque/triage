// Where engines/eda/build.mjs puts the built engine, and how to run it (ROADMAP P1-1).
// A module of its own so build.mjs, the tests and scripts can share it without
// importing each other.
import path from 'node:path';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const edaDir = import.meta.dirname;
const osName = isWindows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

export const buildDir = path.join(edaDir, 'build', osName);
export const stageDir = path.join(buildDir, 'stage', 'bin');

/** The environment a staged program runs with (the app's broker sets the same). */
export function stagedEnv() {
  if (isWindows) return { PATH: `${stageDir}${path.delimiter}${process.env.PATH ?? ''}` };
  return {
    LD_LIBRARY_PATH: `${stageDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
  };
}

/** The path of a staged program (`kicad-cli`, `triage-eda-engine`). */
export function stagedProgram(name) {
  return path.join(stageDir, `${name}${isWindows ? '.exe' : ''}`);
}
