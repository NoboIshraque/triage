#!/usr/bin/env node
// Builds the companion addon and copies it to build/native/addons/triage_companion.node.
//   node crates/triage-companion-node/build.mjs [--debug]
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const profile = process.argv.includes('--debug') ? 'debug' : 'release';
const args = ['build', '-p', 'triage-companion-node', '--locked'];
if (profile === 'release') args.push('--release');
const result = spawnSync('cargo', args, { cwd: repoRoot, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const library =
  {
    win32: 'triage_companion_node.dll',
    darwin: 'libtriage_companion_node.dylib',
  }[process.platform] ?? 'libtriage_companion_node.so';
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, 'target');
const out = path.join(repoRoot, 'build', 'native', 'addons');
mkdirSync(out, { recursive: true });
copyFileSync(path.join(targetDir, profile, library), path.join(out, 'triage_companion.node'));
console.log(`Built ${path.relative(process.cwd(), path.join(out, 'triage_companion.node'))}`);
