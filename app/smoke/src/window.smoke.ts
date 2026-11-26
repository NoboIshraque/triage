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

  beforeAll(async () => {
    mkdirSync(outputDir, { recursive: true });
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

  // ROADMAP P2-3 (a board edit updates the 3D view) and P2-5 (a deliberately tall part
  // gets a red highlight and a problem entry).
  (cadShipped && edaShipped ? it : it.skip)(
    'follows a board edit in 3D and reports a part too tall for the enclosure',
    async () => {
      const updates = async () => Number((await cadView().getAttribute('data-board-updates')) ?? 0);
      const setHeight = async (reference: string, height: string) => {
        const before = await updates();
        await runCommand(window, "Triage: Set a Part's Height (3D and Fit Checks)");
        const input = window.locator('.quick-input-widget .quick-input-box input');
        const prompt = (text: string) =>
          window
            .locator('.quick-input-widget .quick-input-message', { hasText: text })
            .waitFor({ state: 'visible', timeout: 30_000 });
        await prompt('Part reference');
        await input.fill(reference);
        await window.keyboard.press('Enter');
        await prompt(`Height of ${reference}`);
        await input.fill(height);
        await window.keyboard.press('Enter');
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
      await runCommand(window, 'View: Focus Problems (Errors, Warnings, Infos)');
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
    await runCommand(window, 'Triage: Benchmark Schematic and Board Views');
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
    await runCommand(window, 'Triage: Select Part in Schematic and Board');
    // Wait for the command's own prompt: typing earlier lands in the closing palette.
    await window
      .locator('.quick-input-widget .quick-input-message', { hasText: 'References to select' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await window.locator('.quick-input-widget .quick-input-box input').fill('Q1');
    await window.keyboard.press('Enter');
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
    await runCommand(window, 'Triage: Rename Net in the Schematic');
    const input = window.locator('.quick-input-widget .quick-input-box input');
    const prompt = (text: string) =>
      window
        .locator('.quick-input-widget .quick-input-message', { hasText: text })
        .waitFor({ state: 'visible', timeout: 30_000 });
    await prompt('Net to rename');
    await input.fill('FAN_PWM');
    await window.keyboard.press('Enter');
    await prompt('New name for FAN_PWM');
    await input.fill('MOTOR_SPEED');
    await window.keyboard.press('Enter');
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
    await runCommand(window, 'Triage: Kill the KiCad Engine (Restart Test)');
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
