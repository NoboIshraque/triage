#!/usr/bin/env node
// The patch queue of a fork (GUIDELINES §6): numbered *.patch files in
// <fork>/patches/, applied in order onto the pinned upstream checkout.
//
//   node scripts/forks/patches.mjs apply   <fork>          reset upstream, apply every patch
//   node scripts/forks/patches.mjs refresh <fork> [--new NNNN-name]
//                                                          rewrite the patches from upstream's edits
//   node scripts/forks/patches.mjs check   <fork>          apply every patch onto a fresh checkout
//
// Rules: each upstream file belongs to at most one patch, so `refresh` knows
// where every edit goes. Edits to files no patch touches yet go into the patch
// named by --new. A patch whose edits were all undone is deleted. Forks with
// overlay folders (app/) call these functions with the files to leave out.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ForkError, git, main, readPin, run } from './lib.mjs';

const PATCH_NAME = /^\d{4}-[a-z0-9][a-z0-9-]*$/;

export function patchDir(forkDir) {
  return path.join(forkDir, 'patches');
}

/** The fork's patch files, in the order they apply. */
export function listPatches(forkDir) {
  const dir = patchDir(forkDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Paths a patch changes, read from its `diff --git a/… b/…` headers. */
export function filesInPatch(patchFile) {
  const files = [];
  for (const line of readFileSync(patchFile, 'utf8').split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) files.push(match[2]);
  }
  return files;
}

/** Which patch owns each upstream file. Throws if two patches share a file. */
export function patchOwners(forkDir) {
  const owners = new Map();
  for (const patch of listPatches(forkDir)) {
    for (const file of filesInPatch(patch)) {
      const other = owners.get(file);
      if (other) {
        throw new ForkError(
          `${file} is changed by both ${path.basename(other)} and ${path.basename(patch)}; ` +
            'each upstream file belongs to one patch',
        );
      }
      owners.set(file, patch);
    }
  }
  return owners;
}

/** Back to the pinned commit. Ignored files (node_modules, build output) stay. */
export function resetUpstream(upstreamDir) {
  git(upstreamDir, ['reset', '--quiet', '--hard', 'HEAD']);
  git(upstreamDir, ['clean', '--quiet', '-d', '--force']);
}

/** Applies every patch in order onto `upstreamDir` (default: the fork's checkout). */
export function applyPatches(forkDir, upstreamDir = path.join(forkDir, 'upstream')) {
  patchOwners(forkDir);
  const patches = listPatches(forkDir);
  for (const patch of patches) {
    const result = run('git', ['apply', '--whitespace=nowarn', patch], {
      cwd: upstreamDir,
      capture: true,
      allowFailure: true,
    });
    if (result.status !== 0) {
      throw new ForkError(
        `${path.basename(patch)} does not apply to the pinned upstream:\n${result.stderr.trim()}\n` +
          'Fix it by hand in the checkout, then run refresh.',
      );
    }
  }
  return patches;
}

/** Files changed in the checkout relative to the pinned commit, new files included. */
function changedFiles(upstreamDir) {
  const tracked = git(upstreamDir, ['diff', '--name-only', '--no-renames', 'HEAD']).split('\n');
  const untracked = git(upstreamDir, ['ls-files', '--others', '--exclude-standard']).split('\n');
  return { tracked: tracked.filter(Boolean), untracked: untracked.filter(Boolean) };
}

function patchHeader(patchFile) {
  if (!existsSync(patchFile)) return '';
  const text = readFileSync(patchFile, 'utf8');
  const start = text.indexOf('diff --git ');
  return start > 0 ? text.slice(0, start) : '';
}

/**
 * Rewrites the patches from the edits in the upstream checkout.
 * `exclude` holds paths the fork writes itself (product.json, overlay files).
 * Returns { written: [...], deleted: [...] } patch names.
 */
export function refreshPatches(forkDir, { exclude = new Set(), newPatch } = {}) {
  const upstreamDir = path.join(forkDir, 'upstream');
  const owners = patchOwners(forkDir);
  const { tracked, untracked } = changedFiles(upstreamDir);
  const keep = (file) => !exclude.has(file);
  const edits = [...tracked, ...untracked].filter(keep);
  const newFiles = untracked.filter(keep);

  const orphans = edits.filter((file) => !owners.has(file));
  let newPatchFile;
  if (orphans.length > 0) {
    if (!newPatch) {
      throw new ForkError(
        `these edits belong to no patch yet; name a new one with --new NNNN-name:\n  ${orphans.join('\n  ')}`,
      );
    }
    if (!PATCH_NAME.test(newPatch)) {
      throw new ForkError(`patch names look like 0001-short-description, not '${newPatch}'`);
    }
    newPatchFile = path.join(patchDir(forkDir), `${newPatch}.patch`);
    if (existsSync(newPatchFile)) throw new ForkError(`${newPatch}.patch already exists`);
    for (const file of orphans) owners.set(file, newPatchFile);
  }

  // New files only show up in `git diff` once git knows about them.
  if (newFiles.length > 0) git(upstreamDir, ['add', '--intent-to-add', '--', ...newFiles]);

  const byPatch = new Map(listPatches(forkDir).map((patch) => [patch, []]));
  if (newPatchFile) byPatch.set(newPatchFile, []);
  for (const file of edits) byPatch.get(owners.get(file))?.push(file);

  mkdirSync(patchDir(forkDir), { recursive: true });
  const written = [];
  const deleted = [];
  try {
    for (const [patch, files] of byPatch) {
      const diff =
        files.length === 0
          ? ''
          : git(
              upstreamDir,
              [
                'diff',
                '--no-color',
                '--no-ext-diff',
                '--no-renames',
                '--binary',
                '--full-index',
                'HEAD',
                '--',
                ...files,
              ],
              { trim: false },
            );
      if (diff.trim() === '') {
        if (existsSync(patch)) {
          unlinkSync(patch);
          deleted.push(path.basename(patch));
        }
        continue;
      }
      const header = patchHeader(patch) || `Triage patch ${path.basename(patch, '.patch')}.\n\n`;
      writeFileSync(patch, header + (diff.endsWith('\n') ? diff : `${diff}\n`));
      written.push(path.basename(patch));
    }
  } finally {
    if (newFiles.length > 0) git(upstreamDir, ['reset', '--quiet', '--', ...newFiles]);
  }
  return { written, deleted };
}

/**
 * Applies every patch onto a fresh checkout of the pinned commit (a temporary
 * git worktree), so a patch that only applies on top of local state fails here.
 */
export function checkPatches(forkDir) {
  const upstreamDir = path.join(forkDir, 'upstream');
  const pin = readPin(forkDir);
  const scratch = mkdtempSync(path.join(tmpdir(), 'triage-patch-check-'));
  const worktree = path.join(scratch, 'tree');
  git(upstreamDir, ['worktree', 'add', '--quiet', '--detach', worktree, pin.commit]);
  try {
    return applyPatches(forkDir, worktree).map((patch) => path.basename(patch));
  } finally {
    git(upstreamDir, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
    git(upstreamDir, ['worktree', 'prune'], { allowFailure: true });
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  main(() => {
    const [command, fork, ...rest] = process.argv.slice(2);
    if (!command || !fork) {
      throw new ForkError('usage: node scripts/forks/patches.mjs apply|refresh|check <fork-dir>');
    }
    const forkDir = path.resolve(fork);
    if (command === 'apply') {
      resetUpstream(path.join(forkDir, 'upstream'));
      console.log(`Applied ${applyPatches(forkDir).length} patch(es).`);
    } else if (command === 'refresh') {
      const index = rest.indexOf('--new');
      const newPatch = index >= 0 ? rest[index + 1] : undefined;
      const { written, deleted } = refreshPatches(forkDir, { newPatch });
      console.log(
        `Wrote ${written.join(', ') || 'no patches'}; deleted ${deleted.join(', ') || 'none'}.`,
      );
    } else if (command === 'check') {
      const applied = checkPatches(forkDir);
      console.log(`All ${applied.length} patch(es) apply cleanly onto a fresh checkout.`);
    } else {
      throw new ForkError(`unknown command '${command}'`);
    }
  });
}
