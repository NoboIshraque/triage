// Replaces VS Code's name in the packaged app's interface text with Triage's
// (ROADMAP P0-9). Microsoft's trademarks "Visual Studio Code" and "VS Code" must
// not name Triage. app/build.mjs runs this on the packaged app right after
// `gulp vscode-<platform>-<arch>`, so it covers every platform and the Windows
// installer, which is built from the same folder.
//
// What it rewrites (English; language packs bring their own text):
//   resources/app/out/nls.messages.json and .js   workbench strings (localize)
//   resources/app/out/vs/workbench/*.main.js       English originals of commands
//                                                  (localize2), image descriptions in
//                                                  the walkthroughs, and a few texts
//                                                  written into the code (WORKBENCH_TEXTS)
//   resources/app/extensions/*/package.nls.json    built-in extensions' settings,
//                                                  commands and views
//   resources/app/extensions/*/package.json        their names and descriptions
//   resources/app/extensions/*/**.js               their runtime messages: the text of
//                                                  every localized message (`l10n.t("…")`
//                                                  and js-debug's own `t("…")`)
// GitHub's Copilot extension (hidden by default) keeps its manifest's literals and its
// runtime messages: most are prompts for the language model, not interface text. Its
// package.nls.json (settings, commands) is rewritten like every other extension's.
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
const NAMED = /Visual Studio Code|VS Code/;

/** Built-in extensions whose texts stay as they are (see the top of this file). */
export const EXTENSIONS_KEPT = new Set(['copilot']);

/**
 * Text fields of a built-in extension's package.json: its name and description (the
 * Extensions view), and the same kinds of fields in what it contributes (for example
 * a notebook renderer's name). Ids, paths and conditions are never touched.
 */
const TEXT_FIELDS = new Set([
  'displayName',
  'description',
  'markdownDescription',
  'title',
  'shortTitle',
  'label',
  'category',
  'enumDescriptions',
  'markdownEnumDescriptions',
  'deprecationMessage',
  'markdownDeprecationMessage',
]);

/** Rebrands the TEXT_FIELDS of a package.json value, at any depth under `contributes`. */
export function rebrandManifest(manifest, name, counter = { changed: 0 }) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        TEXT_FIELDS.has(key) ? rebrandValue(item, name, counter) : walk(item),
      ]),
    );
  };
  const result = { ...manifest };
  for (const field of ['displayName', 'description']) {
    if (typeof result[field] === 'string')
      result[field] = rebrandValue(result[field], name, counter);
  }
  if (result.contributes) result.contributes = walk(result.contributes);
  return result;
}

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

/** A JavaScript string literal: double, single or back quotes (no substitutions). */
const LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\$]|\\.|\$(?!\{))*\``;

/**
 * Rewrites the literal in group 2 of every match of `pattern` (group 1 is the text
 * before it) when it names VS Code. Only literals are touched, so code stays code.
 */
function rebrandLiterals(source, pattern, name, counter) {
  return source.replace(pattern, (match, before, literal) => {
    if (!NAMED.test(literal)) return match;
    const quote = literal[0];
    const text = literal.slice(1, -1);
    const result = rebrandText(text, name);
    if (result === text) return match;
    counter.changed++;
    return `${before}${quote}${result}${quote}`;
  });
}

/** Localized messages in an extension's bundle: the first argument of `….t(`. */
const RUNTIME_MESSAGE = new RegExp(String.raw`(\.t\(\s*)(${LITERAL})`, 'g');

/** Rebrands the localized runtime messages in a built-in extension's JavaScript. */
export function rebrandRuntimeMessages(source, name, counter = { changed: 0 }) {
  return rebrandLiterals(source, RUNTIME_MESSAGE, name, counter);
}

/**
 * Texts in the workbench's own code: the English originals of command titles and
 * descriptions (localize2: the localized text is in nls.messages.json), descriptions
 * of the walkthroughs' images, and texts written straight into the code.
 */
export const WORKBENCH_TEXTS = [
  new RegExp(String.raw`(localize2\(\d+,\s*)(${LITERAL})`, 'g'),
  new RegExp(String.raw`(altText:\s*)(${LITERAL})`, 'g'),
  // The issue reporter's system information (Help: Report Issue).
  new RegExp(String.raw`(\[\s*)("VS Code Version")`, 'g'),
  new RegExp(String.raw`(addDiagRow\([\w$]+,\s*)("VS Code")`, 'g'),
  // A built-in extension's changelog (the Extensions view).
  new RegExp(String.raw`(Please check the )(\[VS Code Release Notes\])`, 'g'),
];

/** Rebrands the texts in WORKBENCH_TEXTS in a workbench bundle. */
export function rebrandWorkbenchCode(source, name, counter = { changed: 0 }) {
  let result = source;
  for (const pattern of WORKBENCH_TEXTS) {
    result = result.replace(pattern, (match, before, text) => {
      if (!NAMED.test(text)) return match;
      const quoted = /^["'`]/.test(text);
      const inner = quoted ? text.slice(1, -1) : text;
      const rebranded = rebrandText(inner, name);
      if (rebranded === inner) return match;
      counter.changed++;
      return `${before}${quoted ? `${text[0]}${rebranded}${text[0]}` : rebranded}`;
    });
  }
  return result;
}

/** JavaScript files of a built-in extension, without its node_modules. */
export function extensionScripts(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...extensionScripts(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/** Workbench bundles (the editor window and the Agents window). */
export function workbenchBundles(appRoot) {
  return [
    path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    path.join(appRoot, 'out', 'vs', 'sessions', 'sessions.desktop.main.js'),
  ].filter((file) => existsSync(file));
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

  for (const bundle of workbenchBundles(appRoot)) {
    const before = counter.changed;
    const source = readFileSync(bundle, 'utf8');
    const result = rebrandWorkbenchCode(source, name, counter);
    if (counter.changed > before) {
      writeFileSync(bundle, result);
      files++;
    }
  }

  const extensions = path.join(appRoot, 'extensions');
  for (const entry of readdirSync(extensions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(extensions, entry.name);

    const nls = path.join(dir, 'package.nls.json');
    if (existsSync(nls)) {
      const before = counter.changed;
      const rebranded = rebrandValue(JSON.parse(readFileSync(nls, 'utf8')), name, counter);
      if (counter.changed > before) {
        writeFileSync(nls, `${JSON.stringify(rebranded, null, '\t')}\n`);
        files++;
      }
    }

    // Copilot's settings and commands (package.nls.json, above) are interface text;
    // its manifest's own literals and its runtime messages are mostly prompts.
    if (EXTENSIONS_KEPT.has(entry.name)) continue;

    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const before = counter.changed;
      const json = rebrandManifest(JSON.parse(readFileSync(manifest, 'utf8')), name, counter);
      if (counter.changed > before) {
        writeFileSync(manifest, `${JSON.stringify(json, null, '\t')}\n`);
        files++;
      }
    }

    for (const script of extensionScripts(dir)) {
      const source = readFileSync(script, 'utf8');
      if (!NAMED.test(source)) continue;
      const before = counter.changed;
      const result = rebrandRuntimeMessages(source, name, counter);
      if (counter.changed > before) {
        writeFileSync(script, result);
        files++;
      }
    }
  }
  return { files, strings: counter.changed };
}
