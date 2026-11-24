// Shared helpers for the fork scripts (GUIDELINES §6). Plain Node, no
// dependencies, so they run the same on Windows and Linux before any install.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const isWindows = process.platform === 'win32';

export class ForkError extends Error {}

/** Runs a command, streaming its output. Throws ForkError on failure. */
export function run(command, args, options = {}) {
  const { cwd, env, allowFailure = false, capture = false } = options;
  // Windows can only start .cmd shims (corepack, pnpm) through a shell.
  const shell = isWindows && !command.endsWith('.exe') && command !== 'git' && command !== 'node';
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw new ForkError(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    throw new ForkError(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return result;
}

/** Runs git and returns trimmed stdout. */
export function git(cwd, args, options = {}) {
  return run('git', args, { cwd, capture: true, ...options }).stdout.trim();
}

/** Retries `fn` on failure with exponential backoff (network operations). */
export function withRetries(what, fn, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const seconds = 2 ** attempt;
      console.warn(`${what} failed (attempt ${attempt}/${attempts}), retrying in ${seconds}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
    }
  }
}

/** Reads and checks `<forkDir>/upstream.json`. */
export function readPin(forkDir) {
  const file = path.join(forkDir, 'upstream.json');
  if (!existsSync(file)) throw new ForkError(`${file} not found`);
  const pin = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['repository', 'tag', 'commit']) {
    if (typeof pin[key] !== 'string' || pin[key] === '') {
      throw new ForkError(`${file}: "${key}" must be a non-empty string`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw new ForkError(`${file}: "commit" must be a full 40-character SHA`);
  }
  return pin;
}

/** Repository root (this file lives in scripts/forks/). */
export const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** Prints a ForkError without a stack trace and exits; rethrows anything else. */
export function main(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ForkError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
