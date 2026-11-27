// Loads the Rust simulation kernel (crates/triage-sim-node, built as
// triage_sim.node) and types its API.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

/** A device built for a scope (crates/triage-sim-node/src/lib.rs). */
export interface NativeSimulation {
  info(): string;
  now(): number;
  grant(): number[];
  complete(host: number, reached: number, events: Float64Array): Float64Array;
  input(t: number, control: string, value: number): void;
  runUntil(t: number): void;
  value(signal: string): number | null;
  values(ids: Uint32Array): Float64Array;
  trace(signal: string, from?: number | null): Float64Array;
  trimTraces(t: number): void;
  readouts(): string;
  recording(): string;
  stats(): string;
  traceHash(): string;
}

export interface SimAddon {
  Simulation: new (device: string, scope: string, options?: string | null) => NativeSimulation;
  version(): string;
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** Where the addon is: TRIAGE_SIM_ADDON, else the repository's build output. */
export function addonPath(): string {
  return (
    process.env['TRIAGE_SIM_ADDON'] ??
    path.join(repoRoot, 'build', 'native', 'addons', 'triage_sim.node')
  );
}

let loaded: SimAddon | undefined;

/** The addon, loaded once. */
export function loadAddon(file = addonPath()): SimAddon {
  if (!loaded) {
    if (!existsSync(file)) {
      throw new Error(
        `the simulation addon isn't built: run \`node crates/triage-sim-node/build.mjs --mujoco\` (looked for ${file})`,
      );
    }
    loaded = createRequire(import.meta.url)(file) as SimAddon;
  }
  return loaded;
}

/** Whether the addon is built. */
export function addonAvailable(): boolean {
  return existsSync(addonPath());
}

/** Picoseconds per second. */
export const PS_PER_S = 1e12;

/** Logic levels as the addon encodes them. */
export const Logic = { Low: 0, High: 1, Z: 2, WeakLow: 3, WeakHigh: 4 } as const;
