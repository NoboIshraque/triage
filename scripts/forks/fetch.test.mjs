// Tests for fetch.mjs against a throwaway local "upstream" repository.
// Run: node --test "scripts/**/*.test.mjs" (part of `pnpm check`).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchUpstream } from './fetch.mjs';
import { ForkError, git } from './lib.mjs';

const identity = ['-c', 'user.name=Triage Test', '-c', 'user.email=test@example.invalid'];

/** An upstream repository with tags v1 and v2 on consecutive commits. */
function makeUpstream(root) {
  const repo = path.join(root, 'origin');
  git(root, ['init', '--quiet', repo]);
  const commits = {};
  for (const tag of ['v1', 'v2']) {
    writeFileSync(path.join(repo, 'release.txt'), `${tag}\n`);
    git(repo, ['add', 'release.txt']);
    git(repo, [...identity, 'commit', '--quiet', '-m', `release ${tag}`]);
    git(repo, [...identity, 'tag', tag]);
    commits[tag] = git(repo, ['rev-parse', 'HEAD']);
  }
  // file:// so that git honours --depth for a local repository.
  return { url: pathToFileURL(repo).href, commits };
}

function makeFork(root, name, pin) {
  const fork = path.join(root, name);
  git(root, ['init', '--quiet', fork]);
  writeFileSync(path.join(fork, 'upstream.json'), JSON.stringify(pin));
  return fork;
}

describe('fetchUpstream', () => {
  let root;
  let upstream;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'triage-forks-'));
    upstream = makeUpstream(root);
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  it('checks out exactly the pinned commit, and again without refetching', () => {
    const fork = makeFork(root, 'fork-ok', {
      repository: upstream.url,
      tag: 'v1',
      commit: upstream.commits.v1,
    });
    const target = fetchUpstream(fork);
    assert.equal(git(target, ['rev-parse', 'HEAD']), upstream.commits.v1);
    assert.equal(git(target, ['config', 'core.autocrlf']), 'false');
    assert.equal(fetchUpstream(fork), target);
    assert.equal(git(target, ['rev-parse', 'HEAD']), upstream.commits.v1);
  });

  it('refuses a tag that points to a different commit than the pin', () => {
    const fork = makeFork(root, 'fork-moved', {
      repository: upstream.url,
      tag: 'v2',
      commit: upstream.commits.v1,
    });
    assert.throws(
      () => fetchUpstream(fork),
      (error) => {
        assert.ok(error instanceof ForkError);
        assert.match(error.message, /tag v2 points to/);
        return true;
      },
    );
  });

  it('keeps local changes when re-pinning unless forced', () => {
    const fork = makeFork(root, 'fork-repin', {
      repository: upstream.url,
      tag: 'v1',
      commit: upstream.commits.v1,
    });
    const target = fetchUpstream(fork);
    writeFileSync(path.join(target, 'release.txt'), 'edited\n');
    writeFileSync(
      path.join(fork, 'upstream.json'),
      JSON.stringify({ repository: upstream.url, tag: 'v2', commit: upstream.commits.v2 }),
    );
    assert.throws(() => fetchUpstream(fork), /local changes/);
    fetchUpstream(fork, { force: true });
    assert.equal(git(target, ['rev-parse', 'HEAD']), upstream.commits.v2);
    assert.equal(git(target, ['status', '--porcelain']), '');
  });

  it('rejects a pin without a full commit SHA', () => {
    const fork = makeFork(root, 'fork-bad-pin', {
      repository: upstream.url,
      tag: 'v1',
      commit: 'abc123',
    });
    assert.throws(() => fetchUpstream(fork), /full 40-character SHA/);
  });
});
