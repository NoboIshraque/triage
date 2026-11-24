import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT_USAGE, run } from './main.js';
import { TRIAGE_VERSION } from './version.js';

describe('triage CLI', () => {
  it('prints help with no arguments', () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: triage <command>');
    expect(result.stderr).toBe('');
  });

  it('prints the version', () => {
    for (const flag of ['version', '--version', '-v']) {
      expect(run([flag])).toEqual({
        exitCode: 0,
        stdout: `triage ${TRIAGE_VERSION}\n`,
        stderr: '',
      });
    }
  });

  it('rejects unknown commands with a usage error', () => {
    const result = run(['frobnicate']);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("'frobnicate' is not a triage command");
  });

  it('says planned commands are not available yet', () => {
    const result = run(['sim']);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("'sim' is not available yet");
  });

  it('keeps the version equal to package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(TRIAGE_VERSION).toBe(pkg.version);
  });
});
