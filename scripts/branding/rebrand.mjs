// Replaces VS Code's name in the packaged app's interface text with Triage's
// (ROADMAP P0-9). Microsoft's trademarks "Visual Studio Code" and "VS Code" must
// not name Triage. app/build.mjs runs this on the packaged app right after
// `gulp vscode-<platform>-<arch>`, so it covers every platform and the Windows
// installer, which is built from the same folder.
//
// What it rewrites (English; language packs bring their own text):
//   resources/app/out/nls.messages.json and .js   workbench strings (localize)
//   resources/app/extensions/*/package.nls.json    built-in extensions' settings,
//                                                  commands and views
// Built-in extensions' runtime messages (vscode.l10n.t in their bundles) are not
// rewritten: they are code, not data.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Whole strings with a better replacement than the plain name swap. */
export const OVERRIDES = new Map([
  // Triage's own walkthrough is "Get Started with Triage".
  ['Get started with VS Code', 'Get Started with the Code Editor'],
]);

/** Microsoft products named as such; they keep their names. */
export const KEEP = [
  'VS Code Speech',
  'VS Code for the Web',
  'Insiders VS Code',
  'Insiders version of VS Code',
];

const NAME = /Visual Studio Code|VS Code/g;

/** The text with VS Code's name replaced by `name`. */
export function rebrandText(text, name) {
  const override = OVERRIDES.get(text);
  if (override !== undefined) return override;
  const kept = [];
  let result = text;
  for (const phrase of KEEP) {
    // Private-use characters mark the kept phrases while the name is swapped.
    result = result.split(phrase).join(`\uE000${kept.length}\uE001`);
    kept.push(phrase);
  }
  result = result.replace(NAME, name);
  return result.replace(/\uE000(\d+)\uE001/g, (_, index) => kept[Number(index)]);
}

/** Rebrands every string inside a JSON value; counts the strings it changed. */
export function rebrandValue(value, name, counter = { changed: 0 }) {
  if (typeof value === 'string') {
    const result = rebrandText(value, name);
    if (result !== value) counter.changed++;
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => rebrandValue(item, name, counter));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebrandValue(item, name, counter)]),
    );
  }
  return value;
}

const MESSAGES_GLOBAL = 'globalThis._VSCODE_NLS_MESSAGES=';

/**
 * Rebrands the packaged app at `appRoot` (the folder holding out/ and
 * extensions/, i.e. resources/app on Windows and Linux).
 * @returns {{ files: number, strings: number }}
 */
export function rebrandPackagedApp(appRoot, name) {
  const counter = { changed: 0 };
  let files = 0;

  const messagesJson = path.join(appRoot, 'out', 'nls.messages.json');
  const messages = rebrandValue(JSON.parse(readFileSync(messagesJson, 'utf8')), name, counter);
  writeFileSync(messagesJson, JSON.stringify(messages));
  files++;

  // The same messages as a script (web workers and other loaders read this one).
  const messagesJs = path.join(appRoot, 'out', 'nls.messages.js');
  if (existsSync(messagesJs)) {
    const source = readFileSync(messagesJs, 'utf8');
    const start = source.indexOf(MESSAGES_GLOBAL);
    const end = source.lastIndexOf(';');
    if (start < 0 || end < start) {
      throw new Error(`unexpected format: ${messagesJs}`);
    }
    const head = source.slice(0, start + MESSAGES_GLOBAL.length);
    writeFileSync(messagesJs, `${head}${JSON.stringify(messages)}${source.slice(end)}`);
    files++;
  }

  const extensions = path.join(appRoot, 'extensions');
  for (const entry of readdirSync(extensions, { withFileTypes: true })) {
    const nls = path.join(extensions, entry.name, 'package.nls.json');
    if (!entry.isDirectory() || !existsSync(nls)) continue;
    const before = counter.changed;
    const rebranded = rebrandValue(JSON.parse(readFileSync(nls, 'utf8')), name, counter);
    if (counter.changed > before) {
      writeFileSync(nls, `${JSON.stringify(rebranded, null, '\t')}\n`);
      files++;
    }
  }
  return { files, strings: counter.changed };
}
