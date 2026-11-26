#!/usr/bin/env node
// Checks or fixes the formatting of Triage's own C/C++ with clang-format.
// Cross-platform (Linux and Windows). Files inside forked upstream trees and the
// VS Code fork are skipped: they follow upstream style (CLAUDE.md, Conventions).
//
//   node scripts/format/native.mjs --check   # CI: fail if a file needs formatting
//   node scripts/format/native.mjs --write   # reformat in place
//
// CLANG_FORMAT selects the binary (default: clang-format). Formatting differs
// between clang-format major versions, so the major version is pinned below.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const REQUIRED_MAJOR = 18;
const EXTENSIONS = ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx'];
// Generated files (firmware/generated/board_pins.h) are rewritten by Triage, not by hand.
const SKIP = [
  /^app\//,
  /(^|\/)generated\//,
  /(^|\/)upstream\//,
  /(^|\/)patches\//,
  /^engines\/(eda|cad|qemu-esp32)\//,
];
const BATCH = 50;

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  console.error('usage: node scripts/format/native.mjs --check | --write');
  process.exit(2);
}

const clangFormat = process.env.CLANG_FORMAT || 'clang-format';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(2);
  }
  return result;
}

const versionOutput = run(clangFormat, ['--version']).stdout.trim();
const major = Number(/version (\d+)\./.exec(versionOutput)?.[1]);
if (major !== REQUIRED_MAJOR) {
  console.error(
    `Need clang-format ${REQUIRED_MAJOR}.x, found: ${versionOutput || 'nothing'}.\n` +
      `Set CLANG_FORMAT to a clang-format ${REQUIRED_MAJOR} binary (for example clang-format-${REQUIRED_MAJOR}).`,
  );
  process.exit(2);
}

// Tracked files plus new ones not yet added (but not ignored ones), so files
// are formatted before their first commit.
const listed = run('git', [
  'ls-files',
  '-z',
  '--cached',
  '--others',
  '--exclude-standard',
  '--',
  ...EXTENSIONS.map((e) => `*.${e}`),
]);
if (listed.status !== 0) {
  console.error(listed.stderr);
  process.exit(2);
}
const files = [...new Set(listed.stdout.split('\0'))]
  .filter(Boolean)
  .filter((file) => !SKIP.some((pattern) => pattern.test(file)));

const formatArgs = mode === '--check' ? ['--dry-run', '--Werror'] : ['-i'];
let failed = false;
for (let i = 0; i < files.length; i += BATCH) {
  const result = run(clangFormat, [...formatArgs, ...files.slice(i, i + BATCH)]);
  process.stderr.write(result.stderr);
  if (result.status !== 0) failed = true;
}

const verb = mode === '--check' ? 'Checked' : 'Formatted';
console.log(`${verb} ${files.length} C/C++ file(s) with ${versionOutput}.`);
if (failed) {
  console.error('Some files need formatting. Run: pnpm format:native');
  process.exit(1);
}
