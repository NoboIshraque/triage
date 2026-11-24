// Tests for the patch queue (patches.mjs) against a throwaway local upstream.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchUpstream } from './fetch.mjs';
import { ForkError, git } from './lib.mjs';
import {
  applyPatches,
  checkPatches,
  filesInPatch,
  listPatches,
  refreshPatches,
  resetUpstream,
} from './patches.mjs';

const identity = ['-c', 'user.name=Triage Test', '-c', 'user.email=test@example.invalid'];

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A fork whose upstream has a few source files and one CRLF file. */
function makeFork(root) {
  const origin = path.join(root, 'origin');
  git(root, ['init', '--quiet', origin]);
  write(path.join(origin, 'src', 'main.ts'), "import './a.js';\nimport './b.js';\n");
  write(path.join(origin, 'src', 'a.ts'), 'export const a = 1;\n');
  write(path.join(origin, 'src', 'b.ts'), 'export const b = 2;\n');
  write(path.join(origin, 'windows.bat'), '@echo off\r\necho hi\r\n');
  git(origin, ['add', '.']);
  git(origin, [...identity, 'commit', '--quiet', '-m', 'upstream release']);
  git(origin, [...identity, 'tag', 'v1']);
  const fork = path.join(root, 'fork');
  mkdirSync(fork);
  writeFileSync(
    path.join(fork, 'upstream.json'),
    JSON.stringify({
      repository: pathToFileURL(origin).href,
      tag: 'v1',
      commit: git(origin, ['rev-parse', 'HEAD']),
    }),
  );
  fetchUpstream(fork);
  return { fork, upstream: path.join(fork, 'upstream') };
}

describe('patch queue', () => {
  let root;
  let fork;
  let upstream;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'triage-patches-'));
    ({ fork, upstream } = makeFork(root));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  it('turns edits and new files into a new patch that re-applies onto a fresh checkout', () => {
    write(
      path.join(upstream, 'src', 'main.ts'),
      "import './a.js';\nimport './b.js';\nimport './triage.js';\n",
    );
    write(path.join(upstream, 'src', 'triage.ts'), 'export const triage = true;\n');

    assert.throws(() => refreshPatches(fork), /--new NNNN-name/);
    const { written } = refreshPatches(fork, { newPatch: '0001-register-triage' });
    assert.deepEqual(written, ['0001-register-triage.patch']);
    const patch = listPatches(fork)[0];
    assert.deepEqual(filesInPatch(patch).sort(), ['src/main.ts', 'src/triage.ts']);
    assert.match(readFileSync(patch, 'utf8'), /^Triage patch 0001-register-triage\./);

    assert.deepEqual(checkPatches(fork), ['0001-register-triage.patch']);
    resetUpstream(upstream);
    assert.equal(existsSync(path.join(upstream, 'src', 'triage.ts')), false);
    applyPatches(fork);
    assert.match(readFileSync(path.join(upstream, 'src', 'main.ts'), 'utf8'), /triage\.js/);
    assert.equal(git(upstream, ['ls-files', '--others', '--exclude-standard']), 'src/triage.ts');
  });

  it('updates the owning patch, leaves excluded files out, and deletes emptied patches', () => {
    write(path.join(upstream, 'src', 'a.ts'), 'export const a = 10;\n');
    refreshPatches(fork, { newPatch: '0001-change-a' });
    write(path.join(upstream, 'src', 'b.ts'), 'export const b = 20;\n');
    refreshPatches(fork, { newPatch: '0002-change-b' });
    assert.equal(listPatches(fork).length, 2);

    // Edit a again (goes to 0001), undo b (0002 empties), add an overlay-managed file.
    write(path.join(upstream, 'src', 'a.ts'), 'export const a = 100;\n');
    git(upstream, ['checkout', '--', 'src/b.ts']);
    write(path.join(upstream, 'product.json'), '{}\n');
    const result = refreshPatches(fork, { exclude: new Set(['product.json']) });
    assert.deepEqual(result, {
      written: ['0001-change-a.patch'],
      deleted: ['0002-change-b.patch'],
    });
    assert.match(readFileSync(listPatches(fork)[0], 'utf8'), /\+export const a = 100;/);
    assert.deepEqual(filesInPatch(listPatches(fork)[0]), ['src/a.ts']);
  });

  it('keeps CRLF line endings of upstream files byte for byte', () => {
    write(path.join(upstream, 'windows.bat'), '@echo off\r\necho triage\r\n');
    refreshPatches(fork, { newPatch: '0001-windows-script' });
    resetUpstream(upstream);
    applyPatches(fork);
    assert.equal(
      readFileSync(path.join(upstream, 'windows.bat'), 'utf8'),
      '@echo off\r\necho triage\r\n',
    );
  });

  it('names the patch that no longer applies', () => {
    write(
      path.join(fork, 'patches', '0001-stale.patch'),
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 999;\n+export const a = 1000;\n',
    );
    assert.throws(
      () => checkPatches(fork),
      (error) => {
        assert.ok(error instanceof ForkError);
        assert.match(error.message, /0001-stale\.patch does not apply/);
        return true;
      },
    );
    // The temporary worktree is gone again.
    assert.equal(git(upstream, ['worktree', 'list']).split('\n').length, 1);
  });

  it('refuses two patches that change the same file', () => {
    const hunk = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n';
    write(path.join(fork, 'patches', '0001-one.patch'), hunk);
    write(path.join(fork, 'patches', '0002-two.patch'), hunk);
    assert.throws(() => applyPatches(fork), /changed by both 0001-one\.patch and 0002-two\.patch/);
  });

  it('rejects badly named patches', () => {
    write(path.join(upstream, 'src', 'a.ts'), 'export const a = 3;\n');
    assert.throws(() => refreshPatches(fork, { newPatch: 'Fix A' }), /0001-short-description/);
  });
});
