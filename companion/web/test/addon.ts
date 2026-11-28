// The laptop's addon, when it's built (node crates/triage-companion-node/build.mjs).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import type { ICompanionAddon } from '../../../app/src/vs/triage/common/companion/addon.js';

const addonPath = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'build',
  'native',
  'addons',
  'triage_companion.node',
);
if (process.env['TRIAGE_REQUIRE_ADDON'] === '1' && !existsSync(addonPath)) {
  throw new Error(`TRIAGE_REQUIRE_ADDON=1 but ${addonPath} is missing`);
}
export const addon = existsSync(addonPath)
  ? (createRequire(import.meta.url)(addonPath) as ICompanionAddon)
  : undefined;
