import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  rebrandManifest,
  rebrandPackagedApp,
  rebrandRuntimeMessages,
  rebrandText,
  rebrandValue,
  rebrandWorkbenchCode,
} from './rebrand.mjs';

describe('rebrandText', () => {
  it('replaces both forms of the name', () => {
    assert.equal(
      rebrandText('Requires restarting VS Code.', 'Triage'),
      'Requires restarting Triage.',
    );
    assert.equal(rebrandText('Visual Studio Code and VS Code', 'Triage'), 'Triage and Triage');
    assert.equal(rebrandText("VS Code's settings", 'Triage'), "Triage's settings");
  });

  it('leaves identifiers, URLs and other text alone', () => {
    for (const text of ['vscode.dev', 'ms-vscode.cpptools', 'Open a folder', 'VSCode']) {
      assert.equal(rebrandText(text, 'Triage'), text);
    }
  });

  it('keeps the names of Microsoft products', () => {
    assert.equal(
      rebrandText("Install 'VS Code Speech' from 'Microsoft'? VS Code needs it.", 'Triage'),
      "Install 'VS Code Speech' from 'Microsoft'? Triage needs it.",
    );
    assert.equal(
      rebrandText('Not available in VS Code for the Web.', 'Triage'),
      'Not available in VS Code for the Web.',
    );
  });

  it('uses overrides for whole strings', () => {
    assert.equal(
      rebrandText('Get started with VS Code', 'Triage'),
      'Get Started with the Code Editor',
    );
  });
});

describe('rebrandValue', () => {
  it('rebrands nested strings and counts the changes', () => {
    const counter = { changed: 0 };
    const value = rebrandValue(
      { a: 'VS Code', b: { message: 'Restart VS Code', comment: ['x'] }, c: 3, d: null },
      'Triage',
      counter,
    );
    assert.deepEqual(value, {
      a: 'Triage',
      b: { message: 'Restart Triage', comment: ['x'] },
      c: 3,
      d: null,
    });
    assert.equal(counter.changed, 2);
  });
});

describe('rebrandRuntimeMessages', () => {
  it("rewrites the text of localized messages in an extension's bundle", () => {
    const counter = { changed: 0 };
    const source = [
      'a.window.showInformationMessage(a.l10n.t("Please open a folder in VS Code"));',
      "b=c.l10n.t('Use VS Code\\'s Version');",
      'd=$T.t(`Open it in VS Code or the browser`);',
    ].join('\n');
    assert.equal(
      rebrandRuntimeMessages(source, 'Triage', counter),
      [
        'a.window.showInformationMessage(a.l10n.t("Please open a folder in Triage"));',
        "b=c.l10n.t('Use Triage\\'s Version');",
        'd=$T.t(`Open it in Triage or the browser`);',
      ].join('\n'),
    );
    assert.equal(counter.changed, 3);
  });

  it('leaves code, other strings and templates with substitutions alone', () => {
    const source = [
      'throw new Error("VS Code code actions can only be converted");',
      'x.t(`VS Code ${version}`);',
      'const ok = a.l10n.t("Open a folder");',
    ].join('\n');
    assert.equal(rebrandRuntimeMessages(source, 'Triage'), source);
  });
});

describe('rebrandWorkbenchCode', () => {
  it('rewrites command originals, image descriptions and the issue reporter', () => {
    const counter = { changed: 0 };
    const source = [
      'title: localize2(8503, "Signup for the VS Code Newsletter"),',
      'media: { type: "svg", altText: "VS Code Settings", path: "settings.svg" }',
      'rows.push(["VS Code Version", info.vscodeVersion]);',
      'this.addDiagRow(sysTable, "VS Code", info.vscodeVersion);',
      'return `Please check the [VS Code Release Notes](command:${id}) for changes`;',
      'getProductName() { return this.productService.nameShort || "VS Code"; }',
    ].join('\n');
    assert.equal(
      rebrandWorkbenchCode(source, 'Triage', counter),
      [
        'title: localize2(8503, "Signup for the Triage Newsletter"),',
        'media: { type: "svg", altText: "Triage Settings", path: "settings.svg" }',
        'rows.push(["Triage Version", info.vscodeVersion]);',
        'this.addDiagRow(sysTable, "Triage", info.vscodeVersion);',
        'return `Please check the [Triage Release Notes](command:${id}) for changes`;',
        'getProductName() { return this.productService.nameShort || "VS Code"; }',
      ].join('\n'),
    );
    assert.equal(counter.changed, 5);
  });
});

describe('rebrandManifest', () => {
  it("rewrites an extension's names and descriptions, not its ids", () => {
    const counter = { changed: 0 };
    const manifest = {
      name: 'grunt',
      displayName: 'Grunt support for VS Code',
      description: '%description%',
      publisher: 'vscode',
      contributes: {
        notebookRenderer: [
          { id: 'vscode.builtin-renderer', displayName: 'VS Code Builtin Renderer' },
        ],
        commands: [{ command: 'vscode.open', title: 'Open in VS Code', when: 'isVSCode' }],
      },
    };
    assert.deepEqual(rebrandManifest(manifest, 'Triage', counter), {
      name: 'grunt',
      displayName: 'Grunt support for Triage',
      description: '%description%',
      publisher: 'vscode',
      contributes: {
        notebookRenderer: [
          { id: 'vscode.builtin-renderer', displayName: 'Triage Builtin Renderer' },
        ],
        commands: [{ command: 'vscode.open', title: 'Open in Triage', when: 'isVSCode' }],
      },
    });
    assert.equal(counter.changed, 3);
  });
});

describe('rebrandPackagedApp', () => {
  it('rewrites the workbench messages and extension strings', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'triage-rebrand-'));
    try {
      mkdirSync(path.join(root, 'out'));
      mkdirSync(path.join(root, 'extensions', 'git'), { recursive: true });
      mkdirSync(path.join(root, 'extensions', 'theme'), { recursive: true });
      const messages = ['Close', 'Reload VS Code'];
      writeFileSync(path.join(root, 'out', 'nls.messages.json'), JSON.stringify(messages));
      writeFileSync(
        path.join(root, 'out', 'nls.messages.js'),
        `/* header */\nglobalThis._VSCODE_NLS_MESSAGES=${JSON.stringify(messages)};`,
      );
      writeFileSync(
        path.join(root, 'extensions', 'git', 'package.nls.json'),
        JSON.stringify({ 'config.enabled': 'Whether VS Code uses Git' }),
      );
      writeFileSync(
        path.join(root, 'extensions', 'theme', 'package.nls.json'),
        JSON.stringify({ name: 'Dark' }),
      );

      const result = rebrandPackagedApp(root, 'Triage');

      // nls.messages.js repeats the messages; its strings aren't counted twice.
      assert.deepEqual(result, { files: 3, strings: 2 });
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(root, 'out', 'nls.messages.json'), 'utf8')),
        ['Close', 'Reload Triage'],
      );
      assert.equal(
        readFileSync(path.join(root, 'out', 'nls.messages.js'), 'utf8'),
        '/* header */\nglobalThis._VSCODE_NLS_MESSAGES=["Close","Reload Triage"];',
      );
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(root, 'extensions', 'git', 'package.nls.json'), 'utf8')),
        { 'config.enabled': 'Whether Triage uses Git' },
      );
      // Running it again changes nothing.
      assert.deepEqual(rebrandPackagedApp(root, 'Triage'), { files: 2, strings: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites extensions' manifests and runtime messages and the workbench code, not Copilot", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'triage-rebrand-'));
    try {
      mkdirSync(path.join(root, 'out', 'vs', 'workbench'), { recursive: true });
      writeFileSync(path.join(root, 'out', 'nls.messages.json'), '[]');
      writeFileSync(
        path.join(root, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
        'x = { altText: "VS Code Settings" };',
      );
      for (const name of ['grunt', 'copilot']) {
        mkdirSync(path.join(root, 'extensions', name, 'dist'), { recursive: true });
        writeFileSync(
          path.join(root, 'extensions', name, 'package.nls.json'),
          JSON.stringify({ setting: 'Requires VS Code reload.' }),
        );
        mkdirSync(path.join(root, 'extensions', name, 'node_modules'), { recursive: true });
        writeFileSync(
          path.join(root, 'extensions', name, 'package.json'),
          JSON.stringify({ name, displayName: 'Support for VS Code' }),
        );
        writeFileSync(
          path.join(root, 'extensions', name, 'dist', 'main.js'),
          'a.l10n.t("Restart VS Code");',
        );
        writeFileSync(
          path.join(root, 'extensions', name, 'node_modules', 'lib.js'),
          'a.l10n.t("Restart VS Code");',
        );
      }

      assert.deepEqual(rebrandPackagedApp(root, 'Triage'), { files: 6, strings: 5 });
      const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
      assert.equal(
        read('out', 'vs', 'workbench', 'workbench.desktop.main.js'),
        'x = { altText: "Triage Settings" };',
      );
      assert.equal(
        JSON.parse(read('extensions', 'grunt', 'package.json')).displayName,
        'Support for Triage',
      );
      assert.equal(read('extensions', 'grunt', 'dist', 'main.js'), 'a.l10n.t("Restart Triage");');
      // Every extension's package.nls.json, Copilot's too, is interface text.
      for (const name of ['grunt', 'copilot']) {
        assert.equal(
          JSON.parse(read('extensions', name, 'package.nls.json')).setting,
          'Requires Triage reload.',
        );
      }
      // node_modules and Copilot's own literals and runtime messages keep their texts.
      assert.equal(
        read('extensions', 'grunt', 'node_modules', 'lib.js'),
        'a.l10n.t("Restart VS Code");',
      );
      assert.equal(
        read('extensions', 'copilot', 'dist', 'main.js'),
        'a.l10n.t("Restart VS Code");',
      );
      assert.equal(
        JSON.parse(read('extensions', 'copilot', 'package.json')).displayName,
        'Support for VS Code',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
