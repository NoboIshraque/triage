import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRIAGE_VERSION } from './version.js';

// Runs the built CLI as a real process (turbo builds before testing), so the
// Windows and Linux CI jobs both check that `node dist/bin.js` starts. Locally
// the suite is skipped until the package is built; in CI it always runs.
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const inCi = process.env['CI'] !== undefined;

describe.runIf(inCi || existsSync(bin))('built triage binary', () => {
  it('prints the version and exits 0', () => {
    const child = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(`triage ${TRIAGE_VERSION}\n`);
  });

  it('exits 2 on an unknown command', () => {
    const child = spawnSync(process.execPath, [bin, 'frobnicate'], { encoding: 'utf8' });
    expect(child.status).toBe(2);
  });
});
