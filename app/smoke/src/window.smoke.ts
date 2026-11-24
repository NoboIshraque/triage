import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDir, packagedApp, triageProduct } from './app.js';

// Screenshots and logs land here; CI uploads the folder as an artifact.
const outputDir = path.join(appDir, '.smoke');
const shot = (name: string) => path.join(outputDir, `${name}-${process.platform}.png`);

/** GitHub OAuth apps: Triage's own and VS Code's (app/patches/0004-github-sign-in-as-triage.patch). */
const TRIAGE_GITHUB_CLIENT_ID = 'Ov23liajKvj7l41nmMfw';
const VSCODE_GITHUB_CLIENT_ID = '01ab8ac9400c4e429b23';

/** Microsoft products named as such; scripts/branding/rebrand.mjs keeps them (KEEP). */
const MICROSOFT_PRODUCTS = [
  'VS Code Speech',
  'VS Code for the Web',
  'Insiders VS Code',
  'Insiders version of VS Code',
];
const VSCODE_NAME = /Visual Studio Code|VS Code/;

/** Texts that still name VS Code once Microsoft's product names are taken out. */
function namingVSCode(texts: readonly string[]): string[] {
  return texts.filter((text) =>
    VSCODE_NAME.test(MICROSOFT_PRODUCTS.reduce((rest, name) => rest.split(name).join(''), text)),
  );
}

/** The tabs of the Engineering layout (app/src/vs/triage/common/triage.ts). */
const ENGINEERING_TABS = ['code', 'schematic', 'board', '3d', 'sim'];

/**
 * Runs a command through the command palette, as upstream's smoke tests do. Like
 * their openQuickAccessWithRetry (test/automation/src/quickaccess.ts), it retries
 * opening the palette: "Other parts of code might steal focus away from quickinput".
 */
async function runCommand(window: Page, title: string): Promise<void> {
  const input = window.locator('.quick-input-widget .quick-input-box input');
  for (let attempt = 1; ; attempt++) {
    await window.keyboard.press('F1');
    try {
      await input.waitFor({ state: 'visible', timeout: 10_000 });
      break;
    } catch (error) {
      if (attempt === 5) throw error;
    }
  }
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
        // ROADMAP P0-5: open the example project.
        path.join(appDir, '..', 'examples', 'smart-fan'),
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

  // ROADMAP P0-8: GitHub names Triage, not Visual Studio Code, at sign-in.
  it("signs in to GitHub with Triage's own OAuth app", () => {
    const extensions = path.join(path.dirname(app.productJson), 'extensions');
    const signIn = readFileSync(
      path.join(extensions, 'github-authentication', 'dist', 'extension.js'),
      'utf8',
    );
    expect(signIn).toContain(TRIAGE_GITHUB_CLIENT_ID);
    expect(signIn).not.toContain(VSCODE_GITHUB_CLIENT_ID);
  });

  // ROADMAP P0-9: no VS Code name or logo in Triage's interface.
  it("doesn't name VS Code in its interface text or logos", () => {
    const appRoot = path.dirname(app.productJson);
    const messages = JSON.parse(
      readFileSync(path.join(appRoot, 'out', 'nls.messages.json'), 'utf8'),
    ) as unknown[];
    expect(namingVSCode(messages.filter((m): m is string => typeof m === 'string'))).toEqual([]);
    const extensions = path.join(appRoot, 'extensions');
    for (const name of readdirSync(extensions)) {
      const nls = path.join(extensions, name, 'package.nls.json');
      if (!existsSync(nls)) continue;
      const strings = Object.values(
        JSON.parse(readFileSync(nls, 'utf8')) as Record<string, unknown>,
      ).map((value) => JSON.stringify(value));
      expect({ extension: name, naming: namingVSCode(strings) }).toEqual({
        extension: name,
        naming: [],
      });
    }
    // Triage's teal replaces VS Code's logo and Code-OSS's icon.
    for (const logo of ['code-icon.svg', 'vscode-icon.svg']) {
      expect(readFileSync(path.join(appRoot, 'out', 'media', logo), 'utf8')).toContain('#0f766e');
    }
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

  // ROADMAP P0-5: "Opening examples/smart-fan shows the four domains".
  it('shows the four domains of the open Triage project', async () => {
    await expect
      .poll(() => window.locator('.triage-project-name').textContent(), { timeout: 60_000 })
      .toBe('Smart Fan');
    const domains = window.locator('.triage-overview .triage-domain');
    const ids: (string | null)[] = [];
    for (let i = 0; i < (await domains.count()); i++) {
      ids.push(await domains.nth(i).getAttribute('data-domain'));
    }
    expect(ids).toEqual(['code', 'electronics', 'mechanical', 'simulation']);
    await expect.poll(() => domains.first().textContent()).toContain('arduino-uno');
    await window.screenshot({ path: shot('project') });
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
    // Schematic (top row) and 3D (bottom row) get about the same height.
    const top = await window
      .locator('.triage-view-editor[data-triage-view="schematic"]')
      .boundingBox();
    const bottom = await window.locator('.triage-view-editor[data-triage-view="3d"]').boundingBox();
    expect(top?.height ?? 0).toBeGreaterThan((bottom?.height ?? 0) * 0.6);
    await window.screenshot({ path: shot('engineering-layout') });
  });

  // ROADMAP P0-4: the hello engine behind a utility-process broker.
  const engineStatus = () => window.locator('.triage-engine-status').textContent();

  it('starts the hello engine when the Triage view opens', async () => {
    await expect
      .poll(engineStatus, { timeout: 60_000 })
      .toMatch(/connected \(pid \d+, restarts 0\)/);
  });

  it('streams 100 MB/s or more from the engine into the window', async () => {
    await runCommand(window, 'Triage: Benchmark Hello Engine');
    const benchmark = window.locator('.triage-engine-benchmark');
    await expect.poll(() => benchmark.textContent(), { timeout: 120_000 }).toContain('MB/s');
    const text = (await benchmark.textContent()) ?? '';
    const match = /(\d+) MB\/s into the window, (\d+) MB\/s to the broker \((\d+) MiB\)/.exec(text);
    expect(match).not.toBeNull();
    const report = {
      what: 'hello engine -> broker (utility process) -> window, over a local socket and a MessagePort',
      platform: process.platform,
      intoWindowMBps: Number(match?.[1]),
      toBrokerMBps: Number(match?.[2]),
      mebibytes: Number(match?.[3]),
    };
    writeFileSync(
      path.join(outputDir, `benchmark-${process.platform}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report));
    expect(report.intoWindowMBps).toBeGreaterThanOrEqual(100);
  });

  it('shows "reconnecting" when the engine is killed, then recovers', async () => {
    const before = /pid (\d+)/.exec((await engineStatus()) ?? '')?.[1];
    await runCommand(window, 'Triage: Kill Hello Engine (Restart Test)');
    await expect.poll(engineStatus, { timeout: 30_000 }).toContain('reconnecting');
    await expect
      .poll(engineStatus, { timeout: 60_000 })
      .toMatch(/connected \(pid \d+, restarts 1\)/);
    const after = /pid (\d+)/.exec((await engineStatus()) ?? '')?.[1];
    expect(after).not.toBe(before);
    await window.screenshot({ path: shot('engine-recovered') });
  });

  it('offers the Triage walkthrough', async () => {
    await window
      .locator('.triage-overview .monaco-button', { hasText: 'Get Started with Triage' })
      .click();
    await window
      .locator('.gettingStartedContainer', { hasText: 'Get Started with Triage' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    // The Welcome page moves focus to its first step about 300 ms after it opens
    // (observed); that focus move closes a command palette a later test opened.
    await window
      .locator('.getting-started-step.expanded:focus')
      .waitFor({ state: 'visible', timeout: 10_000 });
    // ROADMAP P0-9: the Welcome page names Triage, not VS Code.
    const welcome = await window.locator('.gettingStartedContainer').innerText();
    expect(namingVSCode([welcome])).toEqual([]);
    await window.screenshot({ path: shot('walkthrough') });
  });
  // The owner's request (2026-11-24): VS Code's built-in Copilot chat stays hidden.
  // Checked late, after the chat would have offered itself.
  it("hides VS Code's built-in Copilot chat", async () => {
    expect(await window.locator('.part.auxiliarybar').isVisible()).toBe(false);
    expect(
      await window.locator('.part.titlebar').getByText('Sign In', { exact: true }).count(),
    ).toBe(0);
    const statusItems = await window.locator('.part.statusbar .statusbar-item').all();
    const statusIds = await Promise.all(statusItems.map((item) => item.getAttribute('id')));
    expect(statusIds.filter((id) => id !== null && /chat|copilot/i.test(id))).toEqual([]);
    expect(await window.locator('.notification-toast', { hasText: 'Copilot' }).count()).toBe(0);
  });
  // The owner's request (2026-11-24): views can also live in windows of their own.
  it('opens Schematic, Board, 3D and Sim in separate windows', async () => {
    const app = electronApp;
    if (!app) throw new Error('app not started');
    const before = app.windows().length;
    await runCommand(window, 'Triage: Open Engineering Views in Separate Windows');
    await expect
      .poll(() => app.windows().length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(before + 4);
    const kinds: string[] = [];
    for (const page of app.windows().slice(before)) {
      const view = page.locator('.triage-view-editor');
      await view.waitFor({ state: 'visible', timeout: 30_000 });
      kinds.push((await view.getAttribute('data-triage-view')) ?? '');
    }
    expect(kinds.sort()).toEqual(['3d', 'board', 'schematic', 'sim']);
    // They moved rather than being copied: the main window keeps only Code.
    await expect
      .poll(() => window.locator('.triage-view-editor:visible').getAttribute('data-triage-view'), {
        timeout: 30_000,
      })
      .toBe('code');
    await app.windows()[before]?.screenshot({ path: shot('separate-window') });
    await window.screenshot({ path: shot('main-window-after-pop-out') });
  });
});
