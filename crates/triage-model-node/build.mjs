#!/usr/bin/env node
// Builds the napi addon and copies it to build/native/addons/triage_model.node.
// Cross-platform: cargo names the library differently on each system.
//   node crates/triage-model-node/build.mjs [--debug]
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const profile = process.argv.includes('--debug') ? 'debug' : 'release';
const args = ['build', '-p', 'triage-model-node', '--locked'];
if (profile === 'release') args.push('--release');

const result = spawnSync('cargo', args, { cwd: repoRoot, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const library =
  {
    win32: 'triage_model_node.dll',
    darwin: 'libtriage_model_node.dylib',
  }[process.platform] ?? 'libtriage_model_node.so';
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, 'target');
const out = path.join(repoRoot, 'build', 'native', 'addons');
mkdirSync(out, { recursive: true });
copyFileSync(path.join(targetDir, profile, library), path.join(out, 'triage_model.node'));
console.log(`Built ${path.relative(process.cwd(), path.join(out, 'triage_model.node'))}`);
