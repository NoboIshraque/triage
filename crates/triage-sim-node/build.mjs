#!/usr/bin/env node
// Builds the simulation addon and copies it to build/native/addons/triage_sim.node.
//   node crates/triage-sim-node/build.mjs [--debug] [--mujoco]
// With --mujoco the mechanism steps in MuJoCo (built first by
// `node engines/mujoco/build.mjs`), and its library is copied beside the addon.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const profile = process.argv.includes('--debug') ? 'debug' : 'release';
const mujoco = process.argv.includes('--mujoco');
const args = ['build', '-p', 'triage-sim-node', '--locked'];
if (profile === 'release') args.push('--release');
if (mujoco) args.push('--features', 'mujoco');

const env = { ...process.env };
if (mujoco) env.TRIAGE_REQUIRE_MUJOCO = '1';
const result = spawnSync('cargo', args, { cwd: repoRoot, stdio: 'inherit', env });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const library =
  {
    win32: 'triage_sim_node.dll',
    darwin: 'libtriage_sim_node.dylib',
  }[process.platform] ?? 'libtriage_sim_node.so';
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, 'target');
const out = path.join(repoRoot, 'build', 'native', 'addons');
mkdirSync(out, { recursive: true });
copyFileSync(path.join(targetDir, profile, library), path.join(out, 'triage_sim.node'));

if (mujoco) {
  const os = { win32: 'windows', darwin: 'macos' }[process.platform] ?? 'linux';
  const install =
    process.env.TRIAGE_MUJOCO_DIR ??
    path.join(repoRoot, 'engines', 'mujoco', 'build', os, 'install');
  const dir = path.join(install, process.platform === 'win32' ? 'bin' : 'lib');
  // The file the addon names (its SONAME on Linux: libmujoco.so.4.0.1).
  const names = readdirSync(dir).filter((name) =>
    process.platform === 'win32'
      ? name === 'mujoco.dll'
      : /^libmujoco\.so\.\d/.test(name) || /^libmujoco\.\d.*\.dylib$/.test(name),
  );
  if (names.length === 0 || !existsSync(dir)) throw new Error(`no MuJoCo library in ${dir}`);
  for (const name of names) copyFileSync(path.join(dir, name), path.join(out, name));
}
console.log(
  `Built ${path.relative(process.cwd(), path.join(out, 'triage_sim.node'))}${mujoco ? ' with MuJoCo' : ''}`,
);
