#!/usr/bin/env node
// Checks out a fork's pinned upstream release into <fork>/upstream/ (GUIDELINES §6).
//
//   node scripts/forks/fetch.mjs app            # VS Code, pinned in app/upstream.json
//   node scripts/forks/fetch.mjs app --force    # discard local changes when re-pinning
//
// The checkout is a shallow git clone of exactly the pinned commit. It is not
// committed to this repository: upstream stays untouched, and Triage's changes
// are applied on top by each fork's build (patches, overlays, product.json).
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ForkError, git, main, readPin, repoRoot, withRetries } from './lib.mjs';

export function fetchUpstream(forkDir, { force = false } = {}) {
  const pin = readPin(forkDir);
  const target = path.join(forkDir, 'upstream');
  const label = `${path.relative(repoRoot, forkDir) || forkDir}/upstream`;
  return fetchPin(pin, target, { force, label });
}

/**
 * Checks out `pin` ({ repository, tag, commit }) into `target`: a shallow clone of
 * exactly the pinned commit, refusing a tag that moved. Engines with several
 * upstreams (engines/arduino) call this once per source.
 */
export function fetchPin(pin, target, { force = false, label = target } = {}) {
  if (!existsSync(path.join(target, '.git'))) {
    mkdirSync(target, { recursive: true });
    git(target, ['init', '--quiet']);
    git(target, ['remote', 'add', 'origin', pin.repository]);
  }
  // Keep upstream's bytes exactly as committed (no CRLF conversion on Windows),
  // allow long paths on Windows, and silence the detached-HEAD advice.
  git(target, ['config', 'core.autocrlf', 'false']);
  git(target, ['config', 'core.longpaths', 'true']);
  git(target, ['config', 'advice.detachedHead', 'false']);
  git(target, ['remote', 'set-url', 'origin', pin.repository]);

  const head = git(target, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    allowFailure: true,
  });
  if (head === pin.commit) {
    console.log(`${label} is at ${pin.tag} (${pin.commit.slice(0, 12)})`);
    return target;
  }

  const dirty = head ? git(target, ['status', '--porcelain', '--untracked-files=no']) : '';
  if (dirty && !force) {
    throw new ForkError(
      `${label} has local changes and is not at the pinned commit. ` +
        'Re-run with --force to discard them.',
    );
  }

  console.log(`Fetching ${pin.repository} ${pin.tag} into ${label} …`);
  withRetries('git fetch', () =>
    git(
      target,
      ['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', `refs/tags/${pin.tag}`],
      {
        env: { GIT_LFS_SKIP_SMUDGE: '1' },
      },
    ),
  );
  const fetched = git(target, ['rev-parse', 'FETCH_HEAD^{commit}']);
  if (fetched !== pin.commit) {
    throw new ForkError(
      `tag ${pin.tag} points to ${fetched}, but upstream.json pins ${pin.commit}. ` +
        'Check the release before changing the pin.',
    );
  }
  git(target, ['checkout', '--quiet', '--detach', ...(force ? ['--force'] : []), pin.commit]);
  console.log(`${label} is at ${pin.tag} (${pin.commit.slice(0, 12)})`);
  return target;
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  main(() => {
    const args = process.argv.slice(2);
    const fork = args.find((arg) => !arg.startsWith('--'));
    if (!fork) throw new ForkError('usage: node scripts/forks/fetch.mjs <fork-dir> [--force]');
    fetchUpstream(path.resolve(fork), { force: args.includes('--force') });
  });
}
