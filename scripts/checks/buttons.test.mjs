// Buttons and mouse first (ROADMAP PA-1, PLAN D13, GUIDELINES §4): every Triage
// command a user can run (registered with f1: true) must have a menu entry, in the
// Triage menu (app/src/vs/triage/browser/triageMenus.ts) or a menu of its own
// (`menu:` in its Action2). Commands with f1: false are internal (engine and test
// hooks). The test reads the source, so it needs no app build.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const triageDir = path.resolve(import.meta.dirname, '..', '..', 'app', 'src', 'vs', 'triage');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return name.endsWith('.ts') ? [file] : [];
  });
}

/** The text of the balanced `{ … }` starting at `open`. */
function block(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error('unbalanced braces');
}

/** `NAME = 'id'` constants and `NAME = { key: 'id' }` maps, by the expression that names them. */
function constants(files) {
  const values = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:export )?const ([A-Z_][A-Z0-9_]*) = '([^']+)'/g)) {
      values.set(m[1], m[2]);
    }
    for (const m of text.matchAll(/(?:export )?const ([A-Z_][A-Z0-9_]*) = \{/g)) {
      const body = block(text, (m.index ?? 0) + m[0].length - 1);
      for (const entry of body.matchAll(/(\w+): '([^']+)'/g))
        values.set(`${m[1]}.${entry[1]}`, entry[2]);
    }
  }
  return values;
}

function resolve(expression, values, where) {
  const expr = expression.trim();
  const literal = /^'([^']+)'$/.exec(expr);
  if (literal) return literal[1];
  const value = values.get(expr);
  assert.ok(value, `${where}: can't resolve the command id ${expr}`);
  return value;
}

test('every user-facing Triage command has a menu entry or a button menu', () => {
  const files = sources(triageDir);
  const values = constants(files);
  const commands = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/extends Action2 \{/g)) {
      const at = text.indexOf('super({', m.index);
      if (at < 0) continue;
      const descriptor = block(text, at + 'super('.length);
      const id = /\bid: ([^,\n]+),/.exec(descriptor)?.[1];
      if (!id) continue;
      const where = path.relative(triageDir, file);
      commands.push({
        id: resolve(id, values, where),
        f1: /\bf1: true\b/.test(descriptor),
        ownMenu: /\bmenu: /.test(descriptor),
        where,
      });
    }
  }
  assert.ok(
    commands.length >= 30,
    `only ${commands.length} commands found: is the parser out of date?`,
  );

  const menus = readFileSync(path.join(triageDir, 'browser', 'triageMenus.ts'), 'utf8');
  const start = menus.indexOf('= [', menus.indexOf('export const TRIAGE_MENU'));
  const table = menus.slice(start, menus.indexOf('const MENUS'));
  const inMenu = new Set(
    [...table.matchAll(/\bid: ([^,]+),/g)].map((m) => resolve(m[1], values, 'triageMenus.ts')),
  );

  const missing = commands.filter((c) => c.f1 && !c.ownMenu && !inMenu.has(c.id));
  assert.deepEqual(
    missing.map((c) => `${c.id} (${c.where})`),
    [],
    'user-facing commands with no menu entry: add them to TRIAGE_MENU in triageMenus.ts (and a button where the work happens)',
  );
  // And the table names only commands that exist.
  const known = new Set(commands.map((c) => c.id));
  assert.deepEqual(
    [...inMenu].filter((id) => !known.has(id)),
    [],
    'TRIAGE_MENU names commands nobody registers',
  );
});
