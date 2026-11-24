import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** app/ in this repository (this file is app/smoke/src/app.ts). */
export const appDir = path.resolve(import.meta.dirname, '..', '..');

interface TriageProduct {
  readonly nameShort: string;
  readonly nameLong: string;
  readonly applicationName: string;
}

/** The product.json keys Triage sets (app/product.json). */
export function triageProduct(): TriageProduct {
  return JSON.parse(readFileSync(path.join(appDir, 'product.json'), 'utf8')) as TriageProduct;
}

export interface PackagedApp {
  /** The folder app/build.mjs packaged into, e.g. app/VSCode-win32-x64. */
  readonly folder: string;
  /** The executable inside it: Triage.exe on Windows, triage on Linux. */
  readonly executable: string;
  /** The packaged product.json, as the app reads it at runtime. */
  readonly productJson: string;
}

/**
 * Finds the app that `node app/build.mjs` packaged for this machine, or the one
 * TRIAGE_APP_FOLDER points to.
 */
export function packagedApp(): PackagedApp {
  const product = triageProduct();
  const platform = process.platform;
  const folder =
    process.env['TRIAGE_APP_FOLDER'] ?? path.join(appDir, `VSCode-${platform}-${process.arch}`);
  const executable =
    platform === 'win32'
      ? path.join(folder, `${product.nameShort}.exe`)
      : path.join(folder, product.applicationName);
  if (!existsSync(executable)) {
    throw new Error(`No packaged app at ${executable}. Build it first: node app/build.mjs`);
  }
  // Linux and Windows keep the app's files in resources/app.
  return { folder, executable, productJson: path.join(folder, 'resources', 'app', 'product.json') };
}
