import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDir, packagedApp, triageProduct } from './app.js';

// Screenshots and logs land here; CI uploads the folder as an artifact.
const outputDir = path.join(appDir, '.smoke');
const shot = (name: string) => path.join(outputDir, `${name}-${process.platform}.png`);

/** The tabs of the Engineering layout (app/src/vs/triage/common/triage.ts). */
const ENGINEERING_TABS = ['code', 'schematic', 'board', '3d', 'sim'];

/** Runs a command through the command palette, as upstream's smoke tests do. */
async function runCommand(window: Page, title: string): Promise<void> {
  await window.keyboard.press('F1');
  const input = window.locator('.quick-input-widget .quick-input-box input');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill(`>${title}`);
  await window
    .locator('.quick-input-widget .monaco-list-row', { hasText: title })
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await window.keyboard.press('Enter');
}

describe('packaged Triage app', () => {
  const app = packagedApp();
  const product = triageProduct();
  const profile = mkdtempSync(path.join(tmpdir(), 'triage-smoke-'));
  let electronApp: ElectronApplication | undefined;
  let window: Page;

  beforeAll(async () => {
    mkdirSync(outputDir, { recursive: true });
    electronApp = await electron.launch({
      executablePath: app.executable,
      // The flags VS Code's own smoke tests use, plus a throwaway profile.
      args: [
        '--skip-release-notes',
        '--skip-welcome',
        '--disable-telemetry',
        '--disable-experiments',
        '--disable-updates',
        '--disable-workspace-trust',
        '--no-cached-data',
        `--user-data-dir=${path.join(profile, 'user-data')}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
        `--logsPath=${path.join(outputDir, `logs-${process.platform}`)}`,
      ],
      timeout: 120_000,
    });
    window = await electronApp.firstWindow({ timeout: 120_000 });
  });

  afterAll(async () => {
    await electronApp?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  it('ships Triage branding in its product.json', () => {
    const packaged = JSON.parse(readFileSync(app.productJson, 'utf8')) as Record<string, unknown>;
    expect(packaged['nameShort']).toBe(product.nameShort);
    expect(packaged['applicationName']).toBe(product.applicationName);
    expect(packaged['extensionsGallery']).toMatchObject({
      serviceUrl: 'https://open-vsx.org/vscode/gallery',
    });
  });

  it('opens a window showing the workbench', async () => {
    await window.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 120_000 });
    await window.screenshot({ path: shot('window') });
  });

  it('titles the window with the product name', async () => {
    await expect.poll(() => window.title(), { timeout: 30_000 }).toContain(product.nameLong);
  });

  // ROADMAP P0-3: "Triage sidebar and layout visible".
  it('opens the Triage sidebar from the activity bar', async () => {
    await window.locator('.part.activitybar [aria-label^="Triage"]').first().click();
    await window.locator('.triage-overview').waitFor({ state: 'visible', timeout: 30_000 });
    await window.screenshot({ path: shot('sidebar') });
  });

  it('lays out Code, Schematic, Board, 3D and Sim with one command', async () => {
    await runCommand(window, 'Triage: Open Engineering Layout');
    for (const kind of ENGINEERING_TABS) {
      await window
        .locator(`.tabs-container div.tab[data-resource-name="${kind}"]`)
        .waitFor({ state: 'visible', timeout: 30_000 });
      await window
        .locator(`.triage-view-editor[data-triage-view="${kind}"]`)
        .waitFor({ state: 'visible', timeout: 30_000 });
    }
    expect(await window.locator('.part.editor .editor-group-container').count()).toBe(
      ENGINEERING_TABS.length,
    );
    await window.screenshot({ path: shot('engineering-layout') });
  });

  it('offers the Triage walkthrough', async () => {
    await window
      .locator('.triage-overview .monaco-button', { hasText: 'Get Started with Triage' })
      .click();
    await window
      .locator('.gettingStartedContainer', { hasText: 'Get Started with Triage' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await window.screenshot({ path: shot('walkthrough') });
  });
});
