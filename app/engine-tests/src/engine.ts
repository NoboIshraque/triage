import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const exe = process.platform === 'win32' ? 'triage-hello-engine.exe' : 'triage-hello-engine';

/**
 * The hello engine built by CMake (`cmake --workflow --preset ci`), or the one
 * TRIAGE_HELLO_ENGINE names. Undefined when none is built.
 */
export function helloEngine(): string | undefined {
  const fromEnv = process.env.TRIAGE_HELLO_ENGINE;
  if (fromEnv) return fromEnv;
  return ['ci', 'release', 'dev']
    .map((preset) => path.join(repoRoot, 'build', 'native', preset, 'engines', 'hello', exe))
    .find((candidate) => existsSync(candidate));
}

/** CI's native job sets this, so a missing engine fails instead of skipping. */
export const engineRequired = process.env.TRIAGE_REQUIRE_ENGINE === '1';

export const benchmarkDir = path.join(repoRoot, 'build', 'benchmarks');
