import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { rebrandPackagedApp, rebrandText, rebrandValue } from './rebrand.mjs';

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
});
