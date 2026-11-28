import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * Clicks through the menu bar (ROADMAP PA-1: everything with the mouse; this test
 * never opens the command palette). `path` is a top menu, any submenus, and the
 * item. On a narrow screen VS Code folds menus into "More", which this follows.
 */
async function clickMenu(window: Page, path: readonly string[]): Promise<void> {
  // A menu left open (or a pick list) would swallow the first click.
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  const label = (text: string) =>
    new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const [top, ...rest] = path;
  const button = window.locator('.menubar .menubar-menu-button', { hasText: label(top ?? '') });
  const items = [...rest];
  if (await button.isVisible()) {
    await button.click();
  } else {
    await window.locator('.menubar .menubar-menu-button[aria-label="More"]').click();
    items.unshift(top ?? '');
  }
  for (const [i, text] of items.entries()) {
    const item = window
      .locator('.monaco-menu .action-menu-item')
      .filter({ has: window.locator('.action-label', { hasText: label(text) }) })
      .last();
    await item.waitFor({ state: 'visible', timeout: 30_000 });
    // VS Code ignores a click on a menu item for its first 100 ms ("to avoid accidental
    // clicks", base/browser/ui/menu/menu.ts), and opens a submenu 250 ms after the
    // pointer rests on it: a person's pace.
    await window.waitForTimeout(300);
    if (i < items.length - 1) {
      await item.hover();
      await window.waitForTimeout(300);
    }
    await item.click();
  }
  // The menu closes once the item runs.
  await window
    .locator('.monaco-menu-container')
    .first()
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => undefined);
}

/** A quick input's prompt (a value to type: a net's name, a height), then the value. */
async function answerPrompt(window: Page, prompt: string, value: string): Promise<void> {
  await window
    .locator('.quick-input-widget .quick-input-message', { hasText: prompt })
    .waitFor({ state: 'visible', timeout: 30_000 });
  await window.locator('.quick-input-widget .quick-input-box input').fill(value);
  await window.keyboard.press('Enter');
}

/** Clicks the item of an open quick pick list whose label is exactly `label`. */
async function pickItem(window: Page, label: string): Promise<void> {
  const exact = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const row = window
    .locator('.quick-input-widget .monaco-list-row')
    .filter({ has: window.locator('.label-name', { hasText: exact }) })
    .first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();
}

/** Polls `condition` every 25 ms; resolves with the milliseconds it took. */
async function timeUntil(condition: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`not within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Date.now() - started;
}

describe('packaged Triage app', () => {
  const app = packagedApp();
  const product = triageProduct();
  const profile = mkdtempSync(path.join(tmpdir(), 'triage-smoke-'));
  // A copy of the example: the EDA checks edit and save its files.
  const project = path.join(profile, 'smart-fan');
  cpSync(path.join(appDir, '..', 'examples', 'smart-fan'), project, { recursive: true });
  // ROADMAP P1: KiCad's engine ships in the app when the EDA workflow built it.
  const edaDir = path.join(app.folder, 'resources', 'app', 'engines', 'eda');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const edaShipped = existsSync(path.join(edaDir, `triage-eda-engine${exe}`));
  if (process.env['TRIAGE_REQUIRE_EDA'] === '1' && !edaShipped) {
    throw new Error(`TRIAGE_REQUIRE_EDA is set but ${edaDir} has no engine`);
  }
  const edaIt = edaShipped ? it : it.skip;
  /** The shipped kicad-cli, for checking that stock KiCad reads what Triage saved. */
  const kicadCli = (args: string[]) => {
    const env =
      process.platform === 'win32'
        ? { ...process.env, PATH: `${edaDir};${process.env['PATH'] ?? ''}` }
        : { ...process.env, LD_LIBRARY_PATH: edaDir };
    const result = spawnSync(path.join(edaDir, `kicad-cli${exe}`), args, { env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`kicad-cli ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  let electronApp: ElectronApplication | undefined;
  let window: Page;

  // File → New Project and File → Examples create projects here (ROADMAP PA-6).
  const projectsFolder = path.join(profile, 'projects');
  const userSettings = path.join(profile, 'user-data', 'User', 'settings.json');
  mkdirSync(path.dirname(userSettings), { recursive: true });
  writeFileSync(userSettings, JSON.stringify({ 'triage.projectsFolder': projectsFolder }, null, 2));

  // ROADMAP PC: the phone app (companion/web, built) served here, as GitHub Pages serves it.
  const phoneDist = path.join(appDir, '..', 'companion', 'web', 'dist');
  const companionShipped =
    existsSync(
      path.join(app.folder, 'resources', 'app', 'engines', 'companion', 'triage_companion.node'),
    ) && existsSync(path.join(phoneDist, 'index.html'));
  if (process.env['TRIAGE_REQUIRE_COMPANION'] === '1' && !companionShipped) {
    throw new Error(
      `TRIAGE_REQUIRE_COMPANION is set but the companion addon or ${phoneDist} is missing`,
    );
  }
  let phoneServer: Server | undefined;
  let phoneAppUrl = '';

  beforeAll(async () => {
    mkdirSync(outputDir, { recursive: true });
    if (companionShipped) {
      phoneServer = servePhoneApp(phoneDist);
      await new Promise<void>((resolve) => phoneServer?.listen(0, '127.0.0.1', resolve));
      phoneAppUrl = `http://127.0.0.1:${(phoneServer.address() as AddressInfo).port}`;
      // QR codes open this server's app, at the loopback address (CI's firewalls).
      writeFileSync(
        userSettings,
        JSON.stringify(
          {
            'triage.projectsFolder': projectsFolder,
            'triage.companion.appUrl': phoneAppUrl,
            'triage.companion.address': '127.0.0.1',
          },
          null,
          2,
        ),
      );
    }
    electronApp = await electron.launch({
      executablePath: app.executable,
      // The flags VS Code's own smoke tests use, plus a throwaway profile.
      args: [
        // ROADMAP P0-5: open (a copy of) the example project.
        project,
        '--skip-release-notes',
        '--skip-welcome',
        '--disable-telemetry',
        '--disable-experiments',
        '--disable-updates',
        '--disable-workspace-trust',
        '--no-cached-data',
        // CI machines have no GPU: let Chromium draw WebGL2 in software (SwiftShader),
        // which the Schematic and Board tabs need (ROADMAP P1-4).
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        `--user-data-dir=${path.join(profile, 'user-data')}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
        `--logsPath=${path.join(outputDir, `logs-${process.platform}`)}`,
        // Chromium's sandbox refuses to start as root (a container); CI runs as a user.
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ],
      timeout: 120_000,
    });
    window = await electronApp.firstWindow({ timeout: 120_000 });
  });

  afterAll(async () => {
    phoneServer?.close();
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
    // Triage's logo (K3 Slate, scripts/branding/icons.py) replaces VS Code's and Code-OSS's,
    // and the Agents window's mark (the "Open in Agents" button and the Agents window).
    for (const logo of [
      'code-icon.svg',
      'vscode-icon.svg',
      'sessions-icon.svg',
      'sessions-logo-light.svg',
      'sessions-logo-dark.svg',
    ]) {
      expect(readFileSync(path.join(appRoot, 'out', 'media', logo), 'utf8')).toContain('#1e293b');
    }
  });

  // ROADMAP P0-9, the second sweep (2026-11-26): texts written into code rather than
  // the message files. GitHub's Copilot extension keeps its texts (mostly prompts for
  // the language model; scripts/branding/rebrand.mjs).
  it("doesn't name VS Code in built-in extensions' names, messages or the workbench's own texts", () => {
    const appRoot = path.dirname(app.productJson);
    const extensions = path.join(appRoot, 'extensions');
    const localized = /\.t\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`)/g;
    const scripts = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scripts(full);
        return entry.name.endsWith('.js') ? [full] : [];
      });
    const found: string[] = [];
    for (const name of readdirSync(extensions)) {
      const dir = path.join(extensions, name);
      if (name === 'copilot' || !existsSync(path.join(dir, 'package.json'))) continue;
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        displayName?: string;
        description?: string;
        contributes?: unknown;
      };
      const names = [manifest.displayName ?? '', manifest.description ?? ''];
      JSON.stringify(manifest.contributes ?? {}, (key, value: unknown) => {
        if (
          ['displayName', 'description', 'title', 'label'].includes(key) &&
          typeof value === 'string'
        )
          names.push(value);
        return value;
      });
      found.push(...namingVSCode(names).map((text) => `${name}/package.json: ${text}`));
      for (const script of scripts(dir)) {
        const messages = [...readFileSync(script, 'utf8').matchAll(localized)].map(
          (m) => m[1] ?? '',
        );
        found.push(
          ...namingVSCode(messages).map((text) => `${path.relative(extensions, script)}: ${text}`),
        );
      }
    }
    const workbench = readFileSync(
      path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
      'utf8',
    );
    const workbenchTexts = [
      ...workbench.matchAll(/(?:localize2\(\d+,\s*|altText:\s*)("(?:[^"\\\n]|\\.)*")/g),
    ].map((m) => m[1] ?? '');
    for (const text of ['"VS Code Version"', '[VS Code Release Notes]']) {
      if (workbench.includes(text)) workbenchTexts.push(text);
    }
    found.push(...namingVSCode(workbenchTexts).map((text) => `workbench: ${text}`));
    expect(found).toEqual([]);
  });

  it('opens a window showing the workbench', async () => {
    await window.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 120_000 });
    await window.screenshot({ path: shot('window') });
  });

  // ROADMAP P0-9, the owner's option C: dark themes (the default) show the
  // reversed logo, since K3 Slate disappears on a dark title bar.
  it('shows the reversed logo in the dark title bar', async () => {
    const image = await window.evaluate(
      "getComputedStyle(document.querySelector('.part.titlebar .window-appicon')).backgroundImage",
    );
    expect(String(image)).toContain('triage-logo-dark');
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

  it('lays out Code, Schematic, Board, 3D and Sim with one click', async () => {
    await window
      .locator('.triage-overview .monaco-button', { hasText: 'Open Engineering Layout' })
      .click();
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

  // ROADMAP P2-3: the 3D tab draws the project's FreeCAD documents through FreeCAD's
  // engine, and the board through KiCad's when that ships too.
  const cadDir = path.join(app.folder, 'resources', 'app', 'engines', 'cad');
  const cadShipped = existsSync(path.join(cadDir, 'bin', `FreeCADCmd${exe}`));
  if (process.env['TRIAGE_REQUIRE_CAD'] === '1' && !cadShipped) {
    throw new Error(`TRIAGE_REQUIRE_CAD is set but ${cadDir} has no engine`);
  }
  const cadIt = cadShipped ? it : it.skip;
  const cadView = () => window.locator('.triage-cad-view');
  /** The share of the 3D canvas that isn't background (the view keeps its last frame). */
  const cadCoverage = async () =>
    Number(
      await window.evaluate(`(() => {
        const canvas = document.querySelector('.triage-cad-canvas');
        const gl = canvas && canvas.getContext('webgl2');
        if (!gl) return 0;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let covered = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const d = Math.abs(pixels[i] - pixels[0]) + Math.abs(pixels[i + 1] - pixels[1]) + Math.abs(pixels[i + 2] - pixels[2]);
          if (d > 24) covered++;
        }
        return covered / (pixels.length / 4);
      })()`),
    );

  cadIt("draws the Smart Fan in the 3D tab with FreeCAD's engine", async () => {
    await expect
      .poll(() => cadView().getAttribute('data-state'), { timeout: 180_000 })
      .toBe('ready');
    expect(Number(await cadView().getAttribute('data-objects'))).toBeGreaterThan(0);
    expect(await cadView().getAttribute('data-board')).toBe(edaShipped ? 'shown' : 'error');
    await expect.poll(cadCoverage, { timeout: 30_000 }).toBeGreaterThan(0.01);
    await window.screenshot({ path: shot('cad-view') });
  });

  // ROADMAP P2-4: the enclosure's parameters are edited in the 3D tab's properties
  // panel and it recomputes live; lifting its lid shows the board inside (P2-3).
  cadIt("edits the enclosure's wall thickness in the properties panel", async () => {
    const view = cadView();
    const classes = (await view.getAttribute('class')) ?? '';
    if (classes.includes('narrow') && !classes.includes('panel-open')) {
      // The toolbar may be clipped in a narrow tab; the button still answers.
      await view.locator('.triage-cad-button', { hasText: 'Panel' }).dispatchEvent('click');
    }
    await view.locator('.triage-cad-item', { hasText: 'Enclosure' }).first().click();
    const edits = async () => Number((await view.getAttribute('data-edits')) ?? 0);
    const edit = async (property: string, text: string) => {
      const input = view.locator(`.triage-cad-property input[data-property="${property}"]`);
      await input.waitFor({ state: 'visible', timeout: 30_000 });
      const before = await edits();
      await input.fill(text);
      await input.press('Enter');
      const started = Date.now();
      await expect.poll(edits, { timeout: 30_000, interval: 25 }).toBe(before + 1);
      return Date.now() - started;
    };
    const wallMs = await edit('WallThickness', '3 mm');
    console.log(JSON.stringify({ wallThicknessEditMs: wallMs }));
    expect(await view.locator('.triage-cad-status').textContent()).toContain(
      'WallThickness changed',
    );
    expect(Number(await view.getAttribute('data-problems'))).toBe(0);
    await edit('ExplodeLid', '40 mm');
    await window.screenshot({ path: shot('cad-board-in-enclosure') });
    await edit('ExplodeLid', '0 mm');
    await edit('WallThickness', '2 mm');
  });

  // ROADMAP P2-3 (a board edit updates the 3D view) and P2-5 (a deliberately tall part
  // gets a red highlight and a problem entry).
  (cadShipped && edaShipped ? it : it.skip)(
    'follows a board edit in 3D and reports a part too tall for the enclosure',
    async () => {
      const updates = async () => Number((await cadView().getAttribute('data-board-updates')) ?? 0);
      const setHeight = async (reference: string, height: string) => {
        const before = await updates();
        // The 3D tab's Part Height… button: pick the part, type its height (PA-1).
        await cadView()
          .locator('.triage-cad-button', { hasText: 'Part Height' })
          .dispatchEvent('click');
        await pickItem(window, reference);
        await answerPrompt(window, `Height of ${reference}`, height);
        const started = Date.now();
        await expect.poll(updates, { timeout: 60_000, interval: 50 }).toBeGreaterThan(before);
        return Date.now() - started;
      };
      const problems = async () => Number((await cadView().getAttribute('data-problems')) ?? 0);
      expect(await problems()).toBe(0);

      const editToViewMs = await setHeight('R1', '60');
      console.log(JSON.stringify({ boardEditTo3dMs: editToViewMs }));
      await expect.poll(problems, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(await cadView().getAttribute('data-problem-objects')).toContain('R1');
      // The Problems count in the status bar opens the Problems panel.
      await window.locator('.part.statusbar [id="status.problems"]').click();
      await window
        .locator('.markers-panel .marker-message', { hasText: 'R1' })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      await window.screenshot({ path: shot('cad-fit-problem') });

      // Back to the height the footprint's kind gives (0 = not set).
      await setHeight('R1', '0');
      await expect.poll(problems, { timeout: 30_000 }).toBe(0);
    },
  );

  // ROADMAP P1-4: the Schematic and Board tabs drawn by KiCad's engine.
  const edaView = (kind: string) => window.locator(`.triage-eda-view[data-triage-eda="${kind}"]`);

  edaIt("draws the schematic and the board with KiCad's engine", async () => {
    for (const kind of ['schematic', 'board']) {
      await expect
        .poll(() => edaView(kind).getAttribute('data-state'), { timeout: 180_000 })
        .toBe('ready');
      expect(Number(await edaView(kind).getAttribute('data-groups'))).toBeGreaterThan(20);
    }
    await window.screenshot({ path: shot('eda-views') });
  });

  edaIt('pans and zooms the schematic and board views smoothly', async () => {
    await clickMenu(window, ['Triage', 'Diagnostics', 'Benchmark Schematic and Board Views']);
    const report: Record<string, number> = {};
    for (const kind of ['schematic', 'board']) {
      await expect
        .poll(() => edaView(kind).getAttribute('data-benchmark-fps'), { timeout: 120_000 })
        .not.toBeNull();
      report[kind] = Number(await edaView(kind).getAttribute('data-benchmark-fps'));
    }
    writeFileSync(
      path.join(outputDir, `eda-fps-${process.platform}.json`),
      `${JSON.stringify({ what: 'frames per second while panning and zooming', ...report }, null, 2)}\n`,
    );
    console.log(JSON.stringify(report));
    // CI renders in software (SwiftShader, no GPU), so this only checks that frames are
    // drawn and records the rate; the 60 fps budget is checked on real GPUs (STATUS.md).
    for (const fps of Object.values(report)) expect(fps).toBeGreaterThan(1);
  });

  edaIt('cross-probes a part between the schematic and the board', async () => {
    await clickMenu(window, ['Triage', 'Electronics', 'Select Parts…']);
    await answerPrompt(window, 'References to select', 'Q1');
    for (const kind of ['schematic', 'board']) {
      await expect
        .poll(() => edaView(kind).getAttribute('data-selection'), { timeout: 30_000 })
        .toContain('Q1');
    }
    await window.screenshot({ path: shot('eda-cross-probe') });
  });

  edaIt('edits the board, saves it, and stock KiCad reads the file', async () => {
    const pcb = path.join(project, 'electronics', 'smart-fan.kicad_pcb');
    const before = readFileSync(pcb, 'utf8');
    // Q1 is selected (previous check): rotate it in the Board tab and save.
    await edaView('board').locator('.triage-eda-overlay').click({ button: 'middle' });
    await edaView('board').focus();
    await window.keyboard.press('r');
    await expect
      .poll(() => edaView('board').getAttribute('data-modified'), { timeout: 30_000 })
      .toBe('true');
    await window.keyboard.press('Control+s');
    await expect
      .poll(() => edaView('board').getAttribute('data-saves'), { timeout: 30_000 })
      .toBe('1');
    const after = readFileSync(pcb, 'utf8');
    expect(after).not.toBe(before);
    // kicad-cli (KiCad's own loader) opens the saved board.
    const report = path.join(profile, 'drc.json');
    kicadCli(['pcb', 'drc', '--format', 'json', '--output', report, pcb]);
    expect(existsSync(report)).toBe(true);
  });

  edaIt('renames a net and regenerates board_pins.h within 2 s (ROADMAP P1-5)', async () => {
    const header = path.join(project, 'firmware', 'generated', 'board_pins.h');
    await expect
      .poll(() => (existsSync(header) ? readFileSync(header, 'utf8') : ''), { timeout: 60_000 })
      .toContain('FAN_PWM');
    // The Schematic tab's Rename Net… button (PA-1); a net's right-click menu has it too.
    const renameButton = edaView('schematic').locator(
      '.triage-eda-button[data-action="rename-net"]',
    );
    await renameButton.dispatchEvent('click');
    await answerPrompt(window, 'Net to rename', 'FAN_PWM');
    await answerPrompt(window, 'New name for FAN_PWM', 'MOTOR_SPEED');
    const ms = await timeUntil(() => readFileSync(header, 'utf8').includes('MOTOR_SPEED'), 10_000);
    console.log(JSON.stringify({ renameToHeaderMs: ms }));
    writeFileSync(
      path.join(outputDir, `eda-rename-${process.platform}.json`),
      `${JSON.stringify({ what: 'net renamed in the schematic -> board_pins.h rewritten', milliseconds: ms }, null, 2)}\n`,
    );
    expect(ms).toBeLessThan(2000);
    expect(readFileSync(header, 'utf8')).not.toContain('FAN_PWM');
    // The saved schematic opens in stock KiCad with the new net name.
    const schematic = path.join(project, 'electronics', 'smart-fan.kicad_sch');
    const netlist = path.join(profile, 'smart-fan.net');
    kicadCli(['sch', 'export', 'netlist', '--output', netlist, schematic]);
    expect(readFileSync(netlist, 'utf8')).toContain('MOTOR_SPEED');
    // Rename it back: the simulation checks below build the firmware, which uses FAN_PWM.
    await renameButton.dispatchEvent('click');
    await answerPrompt(window, 'Net to rename', 'MOTOR_SPEED');
    await answerPrompt(window, 'New name for MOTOR_SPEED', 'FAN_PWM');
    await expect.poll(() => readFileSync(header, 'utf8'), { timeout: 10_000 }).toContain('FAN_PWM');
  });

  edaIt('reloads the board within 2 s when KiCad saves it (ROADMAP P1-7)', async () => {
    const pcb = path.join(project, 'electronics', 'smart-fan.kicad_pcb');
    const reloads = async () =>
      Number((await edaView('board').getAttribute('data-reloads')) ?? '0');
    const before = await reloads();
    // What the fallback window's save does: KiCad writes the board file.
    kicadCli(['pcb', 'upgrade', '--force', pcb]);
    const started = Date.now();
    await expect.poll(reloads, { timeout: 10_000, interval: 25 }).toBeGreaterThan(before);
    const ms = Date.now() - started;
    console.log(JSON.stringify({ externalSaveToReloadMs: ms }));
    expect(ms).toBeLessThan(2000);
  });

  edaIt('restarts the KiCad engine when it dies and reopens the documents', async () => {
    const status = () => window.locator('[id="triage.edaEngine"]').textContent();
    await clickMenu(window, ['Triage', 'Diagnostics', 'Kill the KiCad Engine (Restart Test)']);
    await expect.poll(status, { timeout: 30_000 }).toContain('reconnecting');
    await expect.poll(status, { timeout: 120_000 }).toContain('connected');
    for (const kind of ['schematic', 'board']) {
      await expect
        .poll(() => edaView(kind).getAttribute('data-state'), { timeout: 120_000 })
        .toBe('ready');
    }
    await window.screenshot({ path: shot('eda-restarted') });
  });

  // ROADMAP P0-4: the hello engine behind a utility-process broker.
  const engineStatus = () => window.locator('.triage-engine-status').textContent();

  // ROADMAP P3: the simulation ships in the app (engines/sim: the sim package and the
  // Rust kernel with MuJoCo). The whole device needs the firmware built, so the
  // App workflow installs the AVR toolchain (sim/src/firmware.ts) as the Sim one does.
  const simDir = path.join(app.folder, 'resources', 'app', 'engines', 'sim');
  const simShipped = existsSync(path.join(simDir, 'triage_sim.node'));
  if (process.env['TRIAGE_REQUIRE_SIM'] === '1' && !simShipped) {
    throw new Error(`TRIAGE_REQUIRE_SIM is set but ${simDir} has no simulation`);
  }
  const simIt = simShipped ? it : it.skip;
  const simView = () => window.locator('.triage-sim-view');
  const simT = async () => Number((await simView().getAttribute('data-t')) ?? 0);
  /**
   * Moves a slider in the Sim tab with the mouse (PA-1): presses at the place on the
   * track for `value` and nudges. Chromium moves the thumb's centre to a press beside
   * the thumb; a press on the thumb itself only starts a drag, which the nudge ends
   * there.
   */
  const setSlider = async (control: string, value: number) => {
    const input = simView().locator(`input[data-control="${control}"]`);
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    if (!box) throw new Error(`no slider for ${control}`);
    const min = Number(await input.getAttribute('min'));
    const max = Number(await input.getAttribute('max'));
    const thumb = 16;
    const x = box.x + thumb / 2 + ((value - min) / (max - min)) * (box.width - thumb);
    const y = box.y + box.height / 2;
    await window.mouse.move(x, y);
    await window.mouse.down();
    await window.mouse.move(x + 1, y);
    await window.mouse.move(x, y);
    await window.mouse.up();
    // Within two pixels' worth of the value.
    const perPixel = (max - min) / Math.max(1, box.width - thumb);
    expect(Math.abs(Number(await input.inputValue()) - value)).toBeLessThanOrEqual(2 * perPixel);
  };
  /** Presses the Mode button (SW1) as a person clicks: about 0.1 s down. */
  const pressMode = () =>
    simView().locator('button[data-control="SW1.pressed"]').click({ delay: 100 });
  /** Sets a slider to an exact value (checks that need a precise input, not the walk). */
  const setSliderExact = (control: string, value: number) =>
    window.evaluate(`(() => {
      const input = document.querySelector('.triage-sim-view input[data-control="${control}"]');
      if (!input) throw new Error('no slider for ${control}');
      input.value = '${value}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  /** Stops the run, if any: a failed check must not leave the simulation busy for the next. */
  const stopSim = async () => {
    if ((await simView().count()) === 0) return;
    if ((await simView().getAttribute('data-state')) === 'idle') return;
    await simView().locator('.triage-sim-button[data-action="stop"]').click();
    await expect.poll(() => simView().getAttribute('data-state'), { timeout: 30_000 }).toBe('idle');
  };
  const runScope = async (scope: string) => {
    await simView().locator('.triage-sim-button[data-action="stop"]').click();
    await expect.poll(() => simView().getAttribute('data-state'), { timeout: 30_000 }).toBe('idle');
    await simView().locator('select.triage-sim-scope').selectOption({ label: scope });
    await simView().locator('.triage-sim-button[data-action="run"]').click();
    await expect
      .poll(() => simView().getAttribute('data-state'), { timeout: 120_000 })
      .toBe('running');
    const start = await simT();
    await expect.poll(simT, { timeout: 60_000 }).toBeGreaterThan(start + 0.5);
  };

  // P3-4 and P3-5 (PLAN §3 step 6): Run builds the firmware, the emulated Uno reads the
  // thermistor, drives the fan, shows it on the OLED; the rotor turns in the 3D tab.
  simIt(
    'builds and runs the Smart Fan with clicks only and turns the rotor in 3D (ROADMAP PA-1, P3-4, P3-5)',
    async () => {
      // PLAN §3 with the mouse (PA-1): Build, then Run, in the Sim tab.
      await simView().locator('.triage-sim-button[data-action="build"]').click();
      const firmwareStatus = window.locator('.triage-firmware-status');
      await expect
        .poll(() => firmwareStatus.getAttribute('data-state'), { timeout: 180_000 })
        .toMatch(/^(built|error)$/);
      expect(await firmwareStatus.textContent()).toContain('arduino:avr:uno');
      expect(Number(await firmwareStatus.getAttribute('data-flash'))).toBeGreaterThan(5000);
      await simView().locator('.triage-sim-button[data-action="run"]').click();
      await expect
        .poll(() => simView().getAttribute('data-loaded'), { timeout: 60_000 })
        .toBe('true');
      await expect
        .poll(async () => (await simView().getAttribute('data-state')) ?? '', { timeout: 180_000 })
        .toMatch(/^(running|error)$/);
      expect(await simView().getAttribute('data-error')).toBeNull();
      await expect.poll(simT, { timeout: 60_000 }).toBeGreaterThan(1);
      await setSlider('env.room_temperature_c', 35);
      const oled = simView().locator('.triage-sim-oled');
      await expect
        .poll(() => oled.getAttribute('data-text'), { timeout: 60_000 })
        .toMatch(/3[45]\.\dC (79|8\d)%/);
      expect(await simView().locator('.triage-sim-serial').textContent()).toContain('duty=');
      const ratio = Number(await simView().getAttribute('data-ratio'));
      console.log(JSON.stringify({ simulation: 'whole device', realTimeRatio: ratio }));
      if (cadShipped) {
        const angle = async () =>
          Number(
            /rotor=(-?[\d.]+)/.exec((await cadView().getAttribute('data-sim-angle')) ?? '')?.[1] ??
              'NaN',
          );
        const first = await angle();
        await expect.poll(angle, { timeout: 30_000 }).not.toBe(first);
        expect(Number.isFinite(await angle())).toBe(true);
        // P3-4: the status LED (D2) glows on the board while the fan runs.
        await expect
          .poll(async () => (await cadView().getAttribute('data-sim-leds')) ?? '', {
            timeout: 30_000,
          })
          .toMatch(/\bD2=0\.[3-9]/);
      }
      await window.screenshot({ path: shot('sim-whole-device') });
      await setSlider('env.room_temperature_c', 40);
      await expect.poll(() => oled.getAttribute('data-text'), { timeout: 60_000 }).toContain('HOT');
      // The Mode button (SW1), pressed with the mouse: Auto → Max → Off → Auto. The
      // engine holds a click for 0.15 s of simulated time, however slowly it runs.
      await pressMode();
      await expect.poll(() => oled.getAttribute('data-text'), { timeout: 60_000 }).toContain('MAX');
      await pressMode();
      await expect.poll(() => oled.getAttribute('data-text'), { timeout: 60_000 }).toContain('OFF');
      await pressMode();
      await expect
        .poll(() => oled.getAttribute('data-text'), { timeout: 60_000 })
        .toContain('AUTO');
    },
  );

  // P3-5: each scope also runs on its own.
  simIt('runs the circuit, the code and the mechanism each on its own (ROADMAP P3-5)', async () => {
    try {
      await runScope('Circuit only');
      expect(await simView().textContent()).toContain('A1.D9.drive');
      await runScope('Code only');
      expect(
        await simView().locator('.triage-sim-section h3', { hasText: 'Virtual I/O' }).count(),
      ).toBe(1);
      await setSliderExact('net:/TEMP_SENSE.value', 3.03);
      await expect
        .poll(() => simView().locator('.triage-sim-oled').getAttribute('data-text'), {
          timeout: 60_000,
        })
        .toMatch(/3[45]\.\dC (79|8\d)%/);
      await window.screenshot({ path: shot('sim-code-only') });
      await runScope('Mechanism only');
      await setSliderExact('J1.torque.value', 2);
      await runScope('Power stage only');
    } finally {
      await stopSim();
    }
  });

  // P3-6: the project's scenarios run inside the app too.
  simIt("runs the project's scenarios from the Sim tab (ROADMAP P3-6)", async () => {
    await stopSim();
    await simView().locator('.triage-sim-button[data-action="scenarios"]').click();
    await expect
      .poll(() => simView().getAttribute('data-scenarios'), { timeout: 300_000, interval: 500 })
      .toMatch(/^(passed|failed)$/);
    const failed = await simView()
      .locator('.triage-sim-scenario[data-result="failed"]')
      .allTextContents();
    expect(failed).toEqual([]);
    expect(
      await simView().locator('.triage-sim-scenario[data-result="passed"]').count(),
    ).toBeGreaterThanOrEqual(5);
    await window.screenshot({ path: shot('sim-scenarios') });
  });

  // ---- ROADMAP PC: the phone companion, with a scripted phone ---------------------------
  // The phone app (companion/web) in a second Electron window with mobile emulation
  // (no extra browser download), pairing with this app over WebTransport.
  const companionIt = companionShipped && edaShipped ? it : it.skip;
  const phones: Page[] = [];
  const dialog = () => window.locator('.triage-companion-dialog');
  const phonesView = () => window.locator('.triage-phones');
  /** Opens the phone app at a pairing link in a phone-sized window. */
  const openPhone = async (link: string): Promise<Page> => {
    if (!electronApp) throw new Error('no app');
    // The camera opens …/p#<payload>, whose page goes on to …/#p=<payload>; the
    // test opens the second directly (VS Code's main process blocks navigations).
    const url = link.includes('/p#') ? link.replace('/p#', '/#p=') : link;
    const opened = electronApp.waitForEvent('window', { timeout: 30_000 });
    await electronApp.evaluate(createPhoneWindow as never, url);
    const page = await opened;
    phones.push(page);
    return page;
  };
  /** Show on Phone → Pair a New Phone…: the dropdown on the Board tab's bar. */
  const pairNewPhone = async () => {
    await window.locator('.tabs-container div.tab[data-resource-name="board"]').click();
    const group = window.locator('.editor-group-container', {
      has: window.locator('div.tab[data-resource-name="board"]'),
    });
    const dropdown = group.locator('.editor-actions .action-label[aria-label="Show on Phone"]');
    if (await dropdown.isVisible()) {
      await dropdown.click();
      const item = window
        .locator('.monaco-menu .action-menu-item')
        .filter({ hasText: 'Pair a New Phone' })
        .last();
      await item.waitFor({ state: 'visible', timeout: 15_000 });
      await window.waitForTimeout(300);
      await item.click();
    } else {
      await clickMenu(window, ['Triage', 'Show on Phone…']);
    }
    await expect.poll(() => dialog().getAttribute('data-state'), { timeout: 60_000 }).toBe('qr');
    return (await dialog().getAttribute('data-link')) ?? '';
  };
  const phoneError = (phone: Page) => phone.locator('.screen.home .error').textContent();

  companionIt(
    'pairs a scripted phone: wrong digits denied, the six digits, view only, reused QR refused (ROADMAP PC-2, PC-3)',
    async () => {
      const first = await pairNewPhone();
      expect(first).toContain(`${phoneAppUrl}/p#`);
      await window.screenshot({ path: shot('companion-qr') });
      // A phone the person doesn't recognise (other digits): Deny.
      const stranger = await openPhone(first);
      await expect
        .poll(() => dialog().getAttribute('data-state'), { timeout: 60_000 })
        .toBe('request');
      await dialog().locator('[data-answer="deny"]').click();
      await expect.poll(() => phoneError(stranger), { timeout: 30_000 }).toContain('said no');
      // A new code; the phone in the user's hand shows the same digits.
      await expect.poll(() => dialog().getAttribute('data-state'), { timeout: 60_000 }).toBe('qr');
      const link = (await dialog().getAttribute('data-link')) ?? '';
      expect(link).not.toBe(first);
      const phone = await openPhone(link);
      await expect
        .poll(() => dialog().getAttribute('data-state'), { timeout: 60_000 })
        .toBe('request');
      const phoneSas = await phone
        .locator('[data-screen="pairing"]')
        .getAttribute('data-sas', { timeout: 30_000 });
      expect(phoneSas).toMatch(/^\d{6}$/);
      expect(await dialog().getAttribute('data-sas')).toBe(phoneSas);
      await dialog().locator('.triage-companion-name-input').fill('Smoke phone');
      await window.screenshot({ path: shot('companion-digits') });
      await dialog().locator('[data-answer="view"]').click();
      // The phone shows the Board tab, drawn by its own renderer.
      const board = phone.locator('.view.eda[data-view="board"]');
      await expect.poll(() => board.getAttribute('data-state'), { timeout: 60_000 }).toBe('ready');
      expect(Number(await board.getAttribute('data-groups'))).toBeGreaterThan(20);
      expect(await phone.locator('body').getAttribute('data-permission')).toBe('view');
      await phone.screenshot({ path: shot('companion-phone-board') });
      expect(await phonesView().locator('.triage-phone[data-phone="Smoke phone"]').count()).toBe(1);
      // The same QR code again: used, refused.
      const again = await openPhone(link);
      await expect.poll(() => phoneError(again), { timeout: 30_000 }).toContain('already used');
      // The first (rotated away) code: expired.
      const late = await openPhone(first);
      await expect
        .poll(() => phoneError(late), { timeout: 30_000 })
        .toMatch(/expired|already used/);
    },
  );

  companionIt(
    'refuses a view-only phone’s edit, then takes it once the laptop allows editing (ROADMAP PC-2, PC-4)',
    async () => {
      const phone = phones[1];
      if (!phone) throw new Error('no paired phone');
      const board = phone.locator('.view.eda[data-view="board"]');
      const document = Number(await board.getAttribute('data-document'));
      const tryEdit = (text: string) =>
        phone.evaluate(
          async ([doc, value]) => {
            const app = (
              globalThis as unknown as {
                triageCompanion: { eda(c: string, b: unknown): Promise<unknown> };
              }
            ).triageCompanion;
            const items = (await app.eda('getItems', { document: doc, references: ['R1'] })) as {
              items?: { items?: { uuid: string }[] };
            };
            const uuid = items.items?.items?.[0]?.uuid ?? '';
            return app
              .eda('edit', { document: doc, setField: { uuid, field: 'Value', text: value } })
              .then(
                () => 'ok',
                (error: unknown) => String(error),
              );
          },
          [document, text] as const,
        );
      expect(await tryEdit('4.7k')).toContain('may only view');
      expect(await edaView('board').getAttribute('data-modified')).not.toBe('true');
      // Allow Editing, from the Phones section of the Triage side bar.
      await phonesView()
        .locator('.triage-phone[data-phone="Smoke phone"] [data-action="permission"]')
        .click();
      await expect
        .poll(() => phone.locator('body').getAttribute('data-permission'), { timeout: 30_000 })
        .toBe('edit');
      const started = Date.now();
      expect(await tryEdit('4.7k')).toBe('ok');
      // PC-4: the laptop's tab shows it within a second.
      await expect
        .poll(() => edaView('board').getAttribute('data-modified'), { timeout: 10_000 })
        .toBe('true');
      console.log(
        JSON.stringify({ companion: 'phone edit to laptop tab', ms: Date.now() - started }),
      );
      // Undo from the phone, so the project stays as it was.
      await phone.locator('.view.eda [data-action="undo"]').click();
    },
  );

  companionIt('runs the simulation from the phone and streams it back (ROADMAP PC-6)', async () => {
    const phone = phones[1];
    if (!phone || !simShipped) return;
    await stopSim();
    await phone.locator('.tab[data-view="sim"]').click();
    const sim = phone.locator('.view.sim');
    await sim.locator('select.scope').waitFor({ state: 'visible', timeout: 30_000 });
    await sim.locator('select.scope').selectOption({ label: 'Whole device' });
    await sim.locator('[data-action="run"]').click();
    await expect
      .poll(() => simView().getAttribute('data-state'), { timeout: 180_000 })
      .toBe('running');
    await expect.poll(() => sim.getAttribute('data-state'), { timeout: 30_000 }).toBe('running');
    const t0 = Number((await sim.getAttribute('data-t')) ?? 0);
    await expect
      .poll(async () => Number((await sim.getAttribute('data-t')) ?? 0), { timeout: 60_000 })
      .toBeGreaterThan(t0 + 0.5);
    // The room warms, from the phone's slider: the laptop's OLED and the phone's agree.
    await phone.evaluate(`(() => {
      const input = document.querySelector('.view.sim input[data-control="env.room_temperature_c"]');
      if (!input) throw new Error('no room temperature slider');
      input.value = '35';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await expect
      .poll(() => sim.getAttribute('data-oled'), { timeout: 60_000 })
      .toMatch(/3[45]\.\dC (79|8\d)%/);
    await expect
      .poll(() => simView().locator('.triage-sim-oled').getAttribute('data-text'), {
        timeout: 30_000,
      })
      .toMatch(/3[45]\.\dC/);
    console.log(
      JSON.stringify({
        companion: 'sim frames on the phone',
        fps: Number(await sim.getAttribute('data-fps')),
      }),
    );
    await phone.screenshot({ path: shot('companion-phone-sim') });
    if (cadShipped) {
      await phone.locator('.tab[data-view="3d"]').click();
      const cad = phone.locator('.view.cad');
      await expect.poll(() => cad.getAttribute('data-state'), { timeout: 60_000 }).toBe('ready');
      expect(Number(await cad.getAttribute('data-objects'))).toBeGreaterThan(2);
      // The rotor turns on the phone too: the laptop streams its transform.
      const model = () => cad.getAttribute('data-sim-model');
      const before = await model();
      await expect.poll(model, { timeout: 30_000 }).not.toBe(before);
      await phone.screenshot({ path: shot('companion-phone-3d') });
    }
    await phone.locator('.tab[data-view="sim"]').click();
    await sim.locator('[data-action="stop"]').click();
    await expect.poll(() => simView().getAttribute('data-state'), { timeout: 30_000 }).toBe('idle');
  });

  companionIt('removes the phone: its session ends and it is refused (ROADMAP PC-2)', async () => {
    const phone = phones[1];
    if (!phone) throw new Error('no paired phone');
    await phonesView()
      .locator('.triage-phone[data-phone="Smoke phone"] [data-action="remove"]')
      .click();
    await expect
      .poll(() => phone.locator('body').getAttribute('data-connection'), { timeout: 30_000 })
      .toBe('closed');
    expect(await phonesView().locator('.triage-phone').count()).toBe(0);
    for (const page of phones) {
      await page.close().catch(() => undefined);
    }
    await window.screenshot({ path: shot('companion-removed') });
  });

  // PLAN §3's last step with a click (PA-1): the enclosure's print files.
  cadIt('exports the enclosure for printing from the 3D toolbar (ROADMAP PA-1)', async () => {
    const exports = path.join(project, 'mechanical', 'exports');
    rmSync(exports, { recursive: true, force: true });
    await cadView().locator('.triage-cad-button', { hasText: 'Export STL' }).dispatchEvent('click');
    await expect
      .poll(
        () =>
          existsSync(path.join(exports, 'base.stl')) && existsSync(path.join(exports, 'lid.stl')),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);
  });

  // ROADMAP PA-3: the board and port picker in the status bar, and the Serial Monitor
  // for a real board (CI has none plugged in: it says so).
  it('picks the board and port in the status bar and opens the Serial Monitor (ROADMAP PA-3)', async () => {
    const status = window.locator('.part.statusbar [id="triage.arduino.status"]');
    await expect.poll(() => status.textContent(), { timeout: 60_000 }).toMatch(/Arduino Uno/i);
    await status.click();
    await pickItem(window, 'Arduino Nano');
    // The Nano's Processor menu (the Arduino IDE's Tools menu): the old bootloader.
    await pickItem(window, 'ATmega328P (Old Bootloader)');
    await pickItem(window, 'No port: build only');
    await expect.poll(() => status.textContent(), { timeout: 30_000 }).toContain('Arduino Nano');
    // Back to the project's board.
    await status.click();
    await pickItem(window, 'Arduino Uno');
    await pickItem(window, 'No port: build only');
    await expect.poll(() => status.textContent(), { timeout: 30_000 }).toMatch(/Arduino Uno/i);
    await clickMenu(window, ['Triage', 'Serial Monitor']);
    const monitor = window.locator('.triage-serial-monitor');
    await monitor.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await monitor.locator('.triage-arduino-button[data-action="connect"]').count()).toBe(1);
    expect(await monitor.locator('.triage-arduino-status').textContent()).toContain(
      'Plug the board in',
    );
    await window.screenshot({ path: shot('serial-monitor') });
  });

  // ROADMAP PA-4: a library from the Library Manager builds, runs in the simulator and
  // draws on the simulated OLED. The Smart Fan's firmware is swapped for a sketch using
  // Adafruit SSD1306 while this runs.
  simIt(
    'installs Adafruit SSD1306 with the Library Manager; a sketch using it draws on the simulated OLED (ROADMAP PA-4)',
    async () => {
      await window.locator('.part.activitybar [aria-label^="Arduino"]').first().click();
      const libraries = window.locator('.triage-libraries');
      await libraries.waitFor({ state: 'visible', timeout: 60_000 });
      await libraries.locator('input.triage-arduino-search').fill('Adafruit SSD1306');
      await libraries.locator('.triage-arduino-button[data-action="search"]').click();
      const row = libraries.locator('.triage-arduino-item[data-library="Adafruit SSD1306"]');
      await row.waitFor({ state: 'visible', timeout: 300_000 });
      await row.locator('.triage-arduino-button[data-action="install"]').click();
      await expect
        .poll(() => libraries.getAttribute('data-installed-library'), { timeout: 300_000 })
        .toBe('Adafruit SSD1306');
      expect(readFileSync(path.join(project, 'triage.toml'), 'utf8')).toMatch(
        /libraries = \[.*"Adafruit SSD1306@/,
      );
      await window.screenshot({ path: shot('library-manager') });

      const src = path.join(project, 'firmware', 'src');
      const saved = new Map(
        readdirSync(src).map((name) => [name, readFileSync(path.join(src, name))]),
      );
      try {
        for (const name of saved.keys()) rmSync(path.join(src, name));
        cpSync(
          path.join(appDir, '..', 'sim', 'test', 'firmware', 'OledHello', 'OledHello.ino'),
          path.join(src, 'main.cpp'),
        );
        writeFileSync(
          path.join(src, 'main.cpp'),
          `#include <Arduino.h>\n${readFileSync(path.join(src, 'main.cpp'), 'utf8')}`,
        );
        await stopSim();
        await simView().locator('select.triage-sim-scope').selectOption({ label: 'Whole device' });
        await simView().locator('.triage-sim-button[data-action="run"]').click();
        await expect
          .poll(() => simView().locator('.triage-sim-oled').getAttribute('data-text'), {
            timeout: 180_000,
          })
          .toContain('HELLO');
        await window.screenshot({ path: shot('library-oled') });
      } finally {
        await stopSim();
        for (const name of readdirSync(src)) rmSync(path.join(src, name));
        for (const [name, bytes] of saved) writeFileSync(path.join(src, name), bytes);
      }
    },
  );

  // ROADMAP PA-5: the Boards Manager lists the AVR boards as built in.
  it('shows the built-in AVR boards in the Boards Manager (ROADMAP PA-5)', async () => {
    await clickMenu(window, ['Triage', 'Boards Manager']);
    const boards = window.locator('.triage-boards');
    await boards.waitFor({ state: 'visible', timeout: 60_000 });
    const avr = boards.locator('.triage-arduino-item[data-platform="arduino:avr"]');
    await avr.waitFor({ state: 'visible', timeout: 120_000 });
    expect(await avr.textContent()).toContain('built into Triage');
    expect(await avr.textContent()).toContain('Triage simulates some');
    await window.screenshot({ path: shot('boards-manager') });
    // Back to the Triage side bar for the checks that follow.
    await window.locator('.part.activitybar [aria-label^="Triage"]').first().click();
    await window.locator('.triage-overview').waitFor({ state: 'visible', timeout: 30_000 });
  });

  // ROADMAP PA-6: Blink from the examples opens as a new project in a new window; it runs
  // in the simulator (code only: the virtual I/O panel shows D13 blinking) and builds.
  simIt('opens Blink from the examples, simulates it and builds it (ROADMAP PA-6)', async () => {
    const app = electronApp;
    if (!app) throw new Error('app not started');
    await clickMenu(window, ['File', 'Examples…']);
    const opened = app.waitForEvent('window', { timeout: 120_000 });
    await pickItem(window, 'Blink');
    const blink = await opened;
    await blink.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 120_000 });
    await blink.locator('.part.activitybar [aria-label^="Triage"]').first().click();
    await expect
      .poll(() => blink.locator('.triage-project-name').textContent(), { timeout: 60_000 })
      .toBe('Blink');
    expect(existsSync(path.join(projectsFolder, 'Blink', 'Blink', 'Blink.ino'))).toBe(true);
    await blink
      .locator('.triage-overview .monaco-button', { hasText: 'Open Engineering Layout' })
      .click();
    const sim = blink.locator('.triage-sim-view');
    await sim.waitFor({ state: 'visible', timeout: 60_000 });
    await expect.poll(() => sim.getAttribute('data-loaded'), { timeout: 60_000 }).toBe('true');
    await sim.locator('select.triage-sim-scope').selectOption({ label: 'Code only' });
    await sim.locator('.triage-sim-button[data-action="run"]').click();
    const led = sim.locator('.triage-sim-led[data-signal="A1.D13.drive"]');
    await expect
      .poll(async () => Number((await led.getAttribute('data-changes')) ?? 0), { timeout: 180_000 })
      .toBeGreaterThan(3);
    await blink.screenshot({ path: shot('example-blink') });
    await sim.locator('.triage-sim-button[data-action="stop"]').click();
    await blink
      .locator('.triage-overview .monaco-button[data-command="triage.arduino.build"]')
      .click();
    await expect
      .poll(() => blink.locator('.triage-firmware-status').getAttribute('data-state'), {
        timeout: 180_000,
      })
      .toBe('built');
    expect(await blink.locator('.triage-firmware-status').textContent()).toContain(
      'arduino:avr:uno',
    );
    await blink.close();
  });

  it('starts the hello engine when the Triage view opens', async () => {
    await expect
      .poll(engineStatus, { timeout: 60_000 })
      .toMatch(/connected \(pid \d+, restarts 0\)/);
  });

  it('streams 100 MB/s or more from the engine into the window', async () => {
    await window
      .locator('.triage-overview .monaco-button', { hasText: 'Benchmark Hello Engine' })
      .click();
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
    await clickMenu(window, ['Triage', 'Diagnostics', 'Kill Hello Engine (Restart Test)']);
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
  // ROADMAP P0-9: the rebrand rewrites checksummed bundles and updates their checksums,
  // so VS Code's integrity check (it runs a few seconds after start) stays quiet.
  it("doesn't say the installation is corrupt", async () => {
    const corrupt = window.locator('.notification-toast', { hasText: 'appears to be corrupt' });
    expect(await corrupt.count()).toBe(0);
  });
  // The owner's request (2026-11-24): views can also live in windows of their own.
  it('opens Schematic, Board, 3D and Sim in separate windows', async () => {
    const app = electronApp;
    if (!app) throw new Error('app not started');
    const before = app.windows().length;
    await window
      .locator('.triage-overview .monaco-button', { hasText: 'Open in Separate Windows' })
      .click();
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

/** Serves the built phone app (companion/web/dist) as a static site. */
function servePhoneApp(dist: string): Server {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  return createServer((request, response) => {
    let file = decodeURIComponent(new URL(request.url ?? '/', 'http://phone').pathname);
    if (file === '/') file = '/index.html';
    if (file === '/p') file = '/p.html';
    const full = path.join(dist, file);
    if (!full.startsWith(dist) || !existsSync(full)) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': types[path.extname(full)] ?? 'application/octet-stream' })
      .end(readFileSync(full));
  });
}

/** The part of Electron's BrowserWindow the scripted phone uses (no Electron types here). */
interface PhoneWindow {
  readonly webContents: {
    setUserAgent(userAgent: string): void;
    on(event: string, listener: () => void): void;
    enableDeviceEmulation(parameters: unknown): void;
  };
  loadURL(url: string): Promise<void>;
}

/** Runs in the app's main process: a phone-sized window with mobile emulation. */
function createPhoneWindow(
  { BrowserWindow }: { BrowserWindow: new (options: unknown) => PhoneWindow },
  target: string,
): void {
  const phone = new BrowserWindow({
    width: 412,
    height: 860,
    title: 'Scripted phone',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  phone.webContents.setUserAgent(
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  );
  phone.webContents.on('did-finish-load', () => {
    phone.webContents.enableDeviceEmulation({
      screenPosition: 'mobile',
      screenSize: { width: 412, height: 860 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 2,
      viewSize: { width: 412, height: 860 },
      scale: 1,
    });
  });
  void phone.loadURL(target);
}
