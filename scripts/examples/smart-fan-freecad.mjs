#!/usr/bin/env node
// Writes the Smart Fan's FreeCAD documents (examples/smart-fan/mechanical/) with the
// CAD engine's own FreeCADCmd (ROADMAP P2-2), so stock FreeCAD opens them. Build and
// stage the engine first: node engines/cad/build.mjs
//
//   node scripts/examples/smart-fan-freecad.mjs
//
// The geometry is in smart_fan_freecad.py.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stagedEnv, stagedProgram } from '../../engines/cad/stage.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(repoRoot, 'examples', 'smart-fan', 'mechanical');
const program = stagedProgram('FreeCADCmd');
if (!existsSync(program)) {
  console.error(`${program} is missing: run node engines/cad/build.mjs first`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const home = mkdtempSync(path.join(os.tmpdir(), 'triage-freecad-home-'));
try {
  const result = spawnSync(program, [path.join(import.meta.dirname, 'smart_fan_freecad.py')], {
    env: { ...process.env, ...stagedEnv(home), TRIAGE_EXAMPLE_OUT: out },
    input: '',
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    console.error(`FreeCADCmd exited with ${result.status ?? result.signal}`);
    process.exit(1);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
