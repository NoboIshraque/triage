import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const addonPath = path.join(repoRoot, 'build', 'native', 'addons', 'triage_model.node');

export interface JsProject {
  root: string;
  name: string;
  description?: string;
  format: number;
  domains: {
    id: string;
    label: string;
    configured: boolean;
    path: string;
    exists: boolean;
    files: { path: string; exists: boolean }[];
    detail?: string;
  }[];
  board?: string;
}

export interface JsPinMap {
  header: string;
  pins: { pin: string; number: number; net: string; constant?: string; connected: boolean }[];
  diagnostics: { path: string; severity: string; line: number; column: number; message: string }[];
}

export interface TriageModelAddon {
  loadProject(dir: string): JsProject | null;
  pinMap(
    board: string,
    schematic: string,
    components: {
      reference: string;
      libId: string;
      footprint: string;
      pins: { number: string; name: string; net: string }[];
    }[],
    sources: { path: string; text: string }[],
  ): JsPinMap;
  manifestSchema(): string;
  version(): string;
}

/** CI's Rust job sets this after building the addon, so a missing one fails. */
const required = process.env['TRIAGE_REQUIRE_ADDON'] === '1';
if (required && !existsSync(addonPath)) {
  throw new Error(
    `TRIAGE_REQUIRE_ADDON=1 but ${addonPath} is missing (node crates/triage-model-node/build.mjs)`,
  );
}

export const addon: TriageModelAddon | undefined = existsSync(addonPath)
  ? (createRequire(import.meta.url)(addonPath) as TriageModelAddon)
  : undefined;
