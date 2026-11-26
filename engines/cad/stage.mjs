// Where engines/cad/build.mjs puts the built engine, and how to run it (ROADMAP P2-1).
// A module of its own so build.mjs, the tests and scripts can share it without
// importing each other.
import path from 'node:path';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const cadDir = import.meta.dirname;
const osName = isWindows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

export const buildDir = path.join(cadDir, 'build', osName);
/** FreeCAD installed into one relocatable folder: bin/, lib/, Mod/, Ext/, data/. */
export const stageDir = path.join(buildDir, 'stage');

/** Triage's engine host (engines/cad/triage/engine/), staged beside FreeCAD. */
export const stagedEngineDir = path.join(stageDir, 'triage');

/** The script FreeCADCmd runs as Triage's CAD engine (ROADMAP P2-2). */
export const engineScript = path.join(stagedEngineDir, 'triage_cad_engine.py');

/** The path of a staged program (`FreeCADCmd`). */
export function stagedProgram(name) {
  return path.join(stageDir, 'bin', `${name}${isWindows ? '.exe' : ''}`);
}

/**
 * The environment a staged program runs with. FreeCAD finds its modules from the
 * program's own folder; user settings go to a throwaway folder so test runs never
 * read or write the user's real FreeCAD configuration.
 */
export function stagedEnv(userHome) {
  const env = {};
  if (userHome) {
    env.FREECAD_USER_HOME = userHome;
  }
  if (isWindows) {
    env.PATH = `${path.join(stageDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
  }
  return env;
}
