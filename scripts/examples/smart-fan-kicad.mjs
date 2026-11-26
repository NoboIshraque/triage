#!/usr/bin/env node
// Generates the Smart Fan's KiCad project (examples/smart-fan/electronics/,
// ROADMAP P1-4/P1-5, PLAN §3 step 2): an Arduino Uno shield with an NTC
// thermistor divider on A0, a logic-level MOSFET with flyback diode driving a
// 12 V fan from D9, an SSD1306 OLED on I²C and a button on D2.
//
//   node scripts/examples/smart-fan-kicad.mjs
//
// Symbols and footprints come from KiCad's official libraries at the pinned
// KiCad version (fetched with a sparse git checkout), copied into a project
// library (libraries/smart_fan.*) so the project needs nothing installed.
// The schematic connects pins with net labels. The script writes the files,
// then KiCad's own kicad-cli (built from Triage's tree, engines/eda/) loads and
// re-saves them (`sch upgrade` / `pcb upgrade`), so the committed files are
// exactly what KiCad writes; ERC and DRC must then pass without errors.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(root, 'examples', 'smart-fan', 'electronics');
const cacheDir = path.join(root, 'engines', 'eda', 'build', 'libraries');
const pin = JSON.parse(readFileSync(path.join(root, 'engines', 'eda', 'upstream.json'), 'utf8'));
const LIB = 'smart_fan';
const PROJECT = 'smart-fan';

// ---- S-expressions ---------------------------------------------------------------

/** A quoted string atom (bare atoms are plain JS strings). */
class Q {
  constructor(text) {
    this.text = text;
  }
}
const q = (text) => new Q(String(text));

function parse(text) {
  let i = 0;
  const next = () => {
    while (/\s/.test(text[i])) i += 1;
    if (text[i] === '(') {
      i += 1;
      const list = [];
      for (;;) {
        while (/\s/.test(text[i])) i += 1;
        if (text[i] === ')') {
          i += 1;
          return list;
        }
        list.push(next());
      }
    }
    if (text[i] === '"') {
      i += 1;
      let out = '';
      while (text[i] !== '"') {
        if (text[i] === '\\') {
          i += 1;
          out += text[i] === 'n' ? '\n' : text[i];
        } else out += text[i];
        i += 1;
      }
      i += 1;
      return q(out);
    }
    const start = i;
    while (!/[\s()]/.test(text[i])) i += 1;
    return text.slice(start, i);
  };
  return next();
}

function print(node, depth = 0) {
  if (node instanceof Q)
    return `"${node.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  if (!Array.isArray(node)) return String(node);
  const simple = node.every((child) => !Array.isArray(child));
  if (simple) return `(${node.map((child) => print(child)).join(' ')})`;
  const pad = '\t'.repeat(depth + 1);
  const parts = node.map((child) =>
    Array.isArray(child) ? `\n${pad}${print(child, depth + 1)}` : ` ${print(child)}`,
  );
  return `(${parts.join('').trimStart()}\n${'\t'.repeat(depth)})`;
}

const head = (node) => (Array.isArray(node) ? node[0] : undefined);
const find = (node, name) => node.find((child) => head(child) === name);
const findAll = (node, name) => node.filter((child) => head(child) === name);
const atomText = (atom) => (atom instanceof Q ? atom.text : atom);

// ---- KiCad's libraries -------------------------------------------------------------

function sparseCheckout(repo, dir, files) {
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    run('git', [
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      pin.tag,
      '--filter=blob:none',
      '--no-checkout',
      repo,
      dir,
    ]);
  }
  run('git', ['-C', dir, 'checkout', 'HEAD', '--', ...files]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed${options.capture ? `:\n${result.stderr}${result.stdout}` : ''}`,
    );
  return result;
}

const SYMBOLS = {
  Arduino_UNO_R3: 'MCU_Module',
  R: 'Device',
  Thermistor_NTC: 'Device',
  D: 'Device',
  Q_NMOS_GDS: 'Transistor_FET',
  Conn_01x02: 'Connector_Generic',
  Conn_01x04: 'Connector_Generic',
  Barrel_Jack: 'Connector',
  SW_Push: 'Switch',
  PWR_FLAG: 'power',
};

const FOOTPRINTS = {
  Arduino_UNO_R3: 'Module',
  'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal': 'Resistor_THT',
  'R_Axial_DIN0204_L3.6mm_D1.6mm_P7.62mm_Horizontal': 'Resistor_THT',
  'TO-220-3_Vertical': 'Package_TO_SOT_THT',
  'D_DO-41_SOD81_P10.16mm_Horizontal': 'Diode_THT',
  'PinHeader_1x02_P2.54mm_Vertical': 'Connector_PinHeader_2.54mm',
  'PinHeader_1x04_P2.54mm_Vertical': 'Connector_PinHeader_2.54mm',
  BarrelJack_Horizontal: 'Connector_BarrelJack',
  SW_PUSH_6mm: 'Button_Switch_THT',
  'MountingHole_3.2mm_M3': 'MountingHole',
};

function loadLibraries() {
  const symDir = path.join(cacheDir, 'kicad-symbols');
  const fpDir = path.join(cacheDir, 'kicad-footprints');
  sparseCheckout(
    'https://gitlab.com/kicad/libraries/kicad-symbols.git',
    symDir,
    Object.entries(SYMBOLS).map(([name, lib]) => `${lib}.kicad_symdir/${name}.kicad_sym`),
  );
  sparseCheckout(
    'https://gitlab.com/kicad/libraries/kicad-footprints.git',
    fpDir,
    Object.entries(FOOTPRINTS).map(([name, lib]) => `${lib}.pretty/${name}.kicad_mod`),
  );
  const symbols = {};
  for (const [name, lib] of Object.entries(SYMBOLS)) {
    const file = parse(
      readFileSync(path.join(symDir, `${lib}.kicad_symdir`, `${name}.kicad_sym`), 'utf8'),
    );
    symbols[name] = find(file, 'symbol');
  }
  const footprints = {};
  for (const [name, lib] of Object.entries(FOOTPRINTS)) {
    footprints[name] = {
      tree: parse(readFileSync(path.join(fpDir, `${lib}.pretty`, `${name}.kicad_mod`), 'utf8')),
      file: path.join(fpDir, `${lib}.pretty`, `${name}.kicad_mod`),
    };
  }
  return { symbols, footprints };
}

/** Pin number -> connection point (symbol units, y up) and direction, for unit 1. */
function symbolPins(symbol) {
  const pins = new Map();
  for (const unit of findAll(symbol, 'symbol')) {
    for (const p of findAll(unit, 'pin')) {
      const at = find(p, 'at');
      const number = atomText(find(p, 'number')[1]);
      pins.set(number, {
        x: Number(at[1]),
        y: Number(at[2]),
        angle: Number(at[3] ?? 0),
        type: p[1],
      });
    }
  }
  return pins;
}

// ---- The circuit -------------------------------------------------------------------

const FP = (name) => `${LIB}:${name}`;

/** Parts: reference, symbol, value, footprint, schematic position (mm), pin -> net. */
const PARTS = [
  {
    ref: 'A1',
    symbol: 'Arduino_UNO_R3',
    value: 'Arduino_UNO_R3',
    footprint: 'Arduino_UNO_R3',
    at: [76.2, 88.9],
    nets: {
      5: '+5V',
      6: 'GND',
      7: 'GND',
      29: 'GND',
      8: '+12V',
      9: 'TEMP_SENSE',
      13: 'I2C_SDA',
      14: 'I2C_SCL',
      17: 'BUTTON',
      24: 'FAN_PWM',
    },
  },
  {
    ref: 'TH1',
    symbol: 'Thermistor_NTC',
    value: '10k NTC',
    footprint: 'R_Axial_DIN0204_L3.6mm_D1.6mm_P7.62mm_Horizontal',
    at: [124.46, 63.5],
    nets: { 1: '+5V', 2: 'TEMP_SENSE' },
  },
  {
    ref: 'R1',
    symbol: 'R',
    value: '10k',
    footprint: 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal',
    at: [124.46, 81.28],
    nets: { 1: 'TEMP_SENSE', 2: 'GND' },
  },
  {
    ref: 'R2',
    symbol: 'R',
    value: '220',
    footprint: 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal',
    at: [147.32, 63.5],
    nets: { 1: 'FAN_PWM', 2: 'FAN_GATE' },
  },
  {
    ref: 'R3',
    symbol: 'R',
    value: '100k',
    footprint: 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal',
    at: [147.32, 81.28],
    nets: { 1: 'FAN_GATE', 2: 'GND' },
  },
  {
    ref: 'Q1',
    symbol: 'Q_NMOS_GDS',
    value: 'IRLZ44N',
    footprint: 'TO-220-3_Vertical',
    at: [170.18, 88.9],
    nets: { 1: 'FAN_GATE', 2: 'FAN_NEG', 3: 'GND' },
  },
  {
    ref: 'D1',
    symbol: 'D',
    value: '1N4007',
    footprint: 'D_DO-41_SOD81_P10.16mm_Horizontal',
    at: [190.5, 63.5],
    nets: { 1: '+12V', 2: 'FAN_NEG' },
  },
  {
    ref: 'J1',
    symbol: 'Conn_01x02',
    value: 'Fan 12V',
    footprint: 'PinHeader_1x02_P2.54mm_Vertical',
    at: [228.6, 63.5],
    nets: { 1: '+12V', 2: 'FAN_NEG' },
  },
  {
    ref: 'J2',
    symbol: 'Barrel_Jack',
    value: '12V in',
    footprint: 'BarrelJack_Horizontal',
    at: [124.46, 111.76],
    nets: { 1: '+12V', 2: 'GND' },
  },
  {
    ref: 'J3',
    symbol: 'Conn_01x04',
    value: 'SSD1306 OLED',
    footprint: 'PinHeader_1x04_P2.54mm_Vertical',
    at: [170.18, 116.84],
    nets: { 1: 'GND', 2: '+5V', 3: 'I2C_SCL', 4: 'I2C_SDA' },
  },
  {
    ref: 'SW1',
    symbol: 'SW_Push',
    value: 'Mode',
    footprint: 'SW_PUSH_6mm',
    at: [190.5, 116.84],
    nets: { 1: 'BUTTON', 2: 'GND' },
  },
  {
    ref: '#FLG01',
    symbol: 'PWR_FLAG',
    value: 'PWR_FLAG',
    at: [124.46, 132.08],
    nets: { 1: '+12V' },
  },
  { ref: '#FLG02', symbol: 'PWR_FLAG', value: 'PWR_FLAG', at: [139.7, 132.08], nets: { 1: 'GND' } },
];

/** Board placement (mm, relative to the shield's origin, the Arduino footprint's pad 1). */
const PLACEMENT = {
  A1: [0, 0, 0],
  TH1: [-12.7, 6.35, 0],
  R1: [-12.7, 11.43, 0],
  R2: [-12.7, 16.51, 0],
  R3: [-12.7, 21.59, 0],
  D1: [-12.7, 26.67, 0],
  Q1: [6.35, 10.16, 0],
  SW1: [17.78, 6.35, 0],
  J1: [30.48, 6.35, 0],
  J3: [30.48, 17.78, 0],
  J2: [16.51, 36.83, 0],
};

/**
 * The Arduino Uno's mounting holes, relative to the Arduino footprint's pad 1 (mm):
 * Arduino's drawing places them at (13.97, 2.54), (66.04, 7.62) and (66.04, 35.56)
 * from the board's corner; in the footprint the board's edge is at x = -27.94 and its
 * power and analog header (pad 1, y = 0) 2.54 mm from the edge. The Uno's fourth
 * hole, (15.24, 50.8), sits 3.6 mm from the header's pad 32: too close for an M3
 * screw head on the shield (KiCad's DRC says so), so the shield uses three.
 */
const MOUNTING_HOLES = {
  H1: [-13.97, 0],
  H2: [38.1, 5.08],
  H3: [38.1, 33.02],
};

const fmt = (v) => Number(v.toFixed(4));

// ---- Schematic ---------------------------------------------------------------------

function textEffects(justify) {
  const effects = ['effects', ['font', ['size', 1.27, 1.27]]];
  if (justify) effects.push(['justify', ...justify]);
  return effects;
}

function property(name, value, at, hidden = false) {
  const prop = ['property', q(name), q(value), ['at', fmt(at[0]), fmt(at[1]), 0], textEffects()];
  if (hidden) prop.push(['hide', 'yes']);
  return prop;
}

/** A field where the library symbol puts it (library y-up, schematic y-down). */
function libraryField(symbol, name, value, x, y, hidden) {
  const source = findAll(symbol, 'property').find((p) => atomText(p[1]) === name);
  const at = source ? find(source, 'at') : ['at', 0, 0, 0];
  const effects = source ? structuredClone(find(source, 'effects')) : textEffects();
  if (source) restoreQ(effects, find(source, 'effects'));
  const field = [
    'property',
    q(name),
    q(value),
    ['at', fmt(x + Number(at[1])), fmt(y - Number(at[2])), Number(at[3] ?? 0)],
    effects,
  ];
  if (hidden) field.push(['hide', 'yes']);
  return field;
}

function schematic(libs, rootUuid, symbolUuids) {
  const libSymbols = ['lib_symbols'];
  for (const name of [...new Set(PARTS.map((part) => part.symbol))]) {
    const copy = structuredClone(libs.symbols[name], { transfer: [] });
    restoreQ(copy, libs.symbols[name]);
    copy[1] = q(`${LIB}:${name}`);
    libSymbols.push(copy);
  }

  const items = [];
  for (const part of PARTS) {
    const pins = symbolPins(libs.symbols[part.symbol]);
    const [x, y] = part.at;
    const uuid = symbolUuids.get(part.ref);
    const symbol = [
      'symbol',
      ['lib_id', q(`${LIB}:${part.symbol}`)],
      ['at', fmt(x), fmt(y), 0],
      ['unit', 1],
      ['exclude_from_sim', 'no'],
      ['in_bom', part.ref.startsWith('#') ? 'no' : 'yes'],
      ['on_board', part.ref.startsWith('#') ? 'no' : 'yes'],
      ['dnp', 'no'],
      ['uuid', q(uuid)],
      libraryField(
        libs.symbols[part.symbol],
        'Reference',
        part.ref,
        x,
        y,
        part.ref.startsWith('#'),
      ),
      libraryField(libs.symbols[part.symbol], 'Value', part.value, x, y, false),
      property('Footprint', part.footprint ? FP(part.footprint) : '', [x, y], true),
      property('Datasheet', '~', [x, y], true),
    ];
    for (const number of pins.keys()) symbol.push(['pin', q(number), ['uuid', q(randomUUID())]]);
    symbol.push([
      'instances',
      ['project', q(PROJECT), ['path', q(`/${rootUuid}`), ['reference', q(part.ref)], ['unit', 1]]],
    ]);
    items.push(symbol);

    for (const [number, p] of pins) {
      // Library pins are y-up; the schematic is y-down.
      const px = fmt(x + p.x);
      const py = fmt(y - p.y);
      const net = part.nets[number];
      if (!net) {
        if (p.type !== 'no_connect')
          items.push(['no_connect', ['at', px, py], ['uuid', q(randomUUID())]]);
        continue;
      }
      // Horizontal pins get the label on the pin; vertical pins a short wire up or
      // down first, so every label reads left to right and clears the part's text.
      let [lx, ly] = [px, py];
      if (p.angle === 90 || p.angle === 270) {
        ly = fmt(py + (p.angle === 270 ? -2.54 : 2.54));
        items.push([
          'wire',
          ['pts', ['xy', px, py], ['xy', lx, ly]],
          ['stroke', ['width', 0], ['type', 'default']],
          ['uuid', q(randomUUID())],
        ]);
      }
      const [angle, justify] = p.angle === 0 ? [180, ['right']] : [0, ['left']];
      items.push([
        'label',
        q(net),
        ['at', lx, ly, angle],
        ['fields_autoplaced', 'yes'],
        textEffects([...justify, 'bottom']),
        ['uuid', q(randomUUID())],
      ]);
    }
  }

  return [
    'kicad_sch',
    ['version', 20260306],
    ['generator', q('triage')],
    ['generator_version', q('0.1')],
    ['uuid', q(rootUuid)],
    ['paper', q('A4')],
    [
      'title_block',
      ['title', q('Smart Fan')],
      ['company', q('Triage example (PLAN §3)')],
      ['comment', 1, q('Arduino Uno shield: NTC on A0, fan PWM on D9, OLED on I2C, button on D2')],
    ],
    libSymbols,
    ...items,
    ['sheet_instances', ['path', q('/'), ['page', q('1')]]],
  ];
}

/** structuredClone drops the Q class: put the quoting back by walking both trees. */
function restoreQ(copy, original) {
  for (let i = 0; i < original.length; i++) {
    if (original[i] instanceof Q) copy[i] = q(original[i].text);
    else if (Array.isArray(original[i])) restoreQ(copy[i], original[i]);
  }
}

// ---- Board -------------------------------------------------------------------------

function boardHeader() {
  // The general, paper, layers and setup sections of a KiCad 10 two-layer board,
  // taken from KiCad's own pic_programmer demo.
  const demo = parse(
    readFileSync(
      path.join(root, 'engines/eda/upstream/demos/pic_programmer/pic_programmer.kicad_pcb'),
      'utf8',
    ),
  );
  return ['general', 'paper', 'layers', 'setup'].map((name) => find(demo, name));
}

function fabBox(fp) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (['fp_line', 'fp_rect', 'fp_poly', 'fp_arc'].includes(head(node))) {
      const layer = find(node, 'layer');
      if (layer && atomText(layer[1]) === 'F.Fab') {
        const walk = (n) => {
          if (!Array.isArray(n)) return;
          if (['start', 'end', 'xy', 'mid'].includes(head(n))) {
            x0 = Math.min(x0, Number(n[1]));
            x1 = Math.max(x1, Number(n[1]));
            y0 = Math.min(y0, Number(n[2]));
            y1 = Math.max(y1, Number(n[2]));
          }
          n.forEach(walk);
        };
        walk(node);
      }
    }
    node.forEach(visit);
  };
  visit(fp);
  return { x0, y0, x1, y1 };
}

function board(libs, rootUuid, symbolUuids) {
  const origin = [100, 80];
  const items = [];
  for (const part of PARTS) {
    if (!part.footprint) continue;
    const source = libs.footprints[part.footprint].tree;
    const fp = structuredClone(source);
    restoreQ(fp, source);
    const [dx, dy, rot] = PLACEMENT[part.ref];
    const kept = fp.filter(
      (child, index) =>
        index < 2 || !['version', 'generator', 'generator_version'].includes(head(child)),
    );
    kept[1] = q(FP(part.footprint));
    const layerIndex = kept.findIndex((child) => head(child) === 'layer');
    kept.splice(
      layerIndex + 1,
      0,
      ['uuid', q(randomUUID())],
      ['at', fmt(origin[0] + dx), fmt(origin[1] + dy), ...(rot ? [rot] : [])],
    );
    if (part.footprint === 'Arduino_UNO_R3') {
      // The Uno sits under the shield: its courtyard (the whole board) would make
      // every part on the shield "overlap" it.
      for (let i = kept.length - 1; i >= 0; i--) {
        const layer = Array.isArray(kept[i]) ? find(kept[i], 'layer') : undefined;
        if (layer && atomText(layer[1]) === 'F.CrtYd') kept.splice(i, 1);
      }
    }
    for (const child of kept) {
      if (head(child) === 'property') {
        if (atomText(child[1]) === 'Reference') child[2] = q(part.ref);
        if (atomText(child[1]) === 'Value') child[2] = q(part.value);
      }
      if (head(child) === 'pad') {
        // Net names as KiCad's "Update PCB from Schematic" writes them: local
        // labels on the root sheet are "/NAME".
        const net = part.nets[atomText(child[1])];
        if (net) child.push(['net', q(`/${net}`)]);
      }
    }
    kept.push(
      ['path', q(`/${symbolUuids.get(part.ref)}`)],
      ['sheetname', q('/')],
      ['sheetfile', q(`${PROJECT}.kicad_sch`)],
    );
    items.push(kept);
  }

  // Three of the Uno's M3 mounting holes (ROADMAP P2-4: the enclosure's screw bosses go
  // under them), board-only footprints like those "Add Mounting Hole" places.
  for (const [ref, [dx, dy]] of Object.entries(MOUNTING_HOLES)) {
    const source = libs.footprints['MountingHole_3.2mm_M3'].tree;
    const fp = structuredClone(source);
    restoreQ(fp, source);
    const kept = fp.filter(
      (child, index) =>
        index < 2 || !['version', 'generator', 'generator_version'].includes(head(child)),
    );
    kept[1] = q(FP('MountingHole_3.2mm_M3'));
    const layerIndex = kept.findIndex((child) => head(child) === 'layer');
    kept.splice(
      layerIndex + 1,
      0,
      ['uuid', q(randomUUID())],
      ['at', fmt(origin[0] + dx), fmt(origin[1] + dy)],
    );
    for (const child of kept) {
      if (head(child) === 'property' && atomText(child[1]) === 'Reference') child[2] = q(ref);
      // "Not in schematic": the holes have no symbols.
      if (head(child) === 'attr' && !child.includes('board_only')) child.push('board_only');
    }
    items.push(kept);
  }

  // The board outline: the Arduino shield's outline from the Uno footprint's fabrication layer.
  const box = fabBox(libs.footprints.Arduino_UNO_R3.tree);
  items.push([
    'gr_rect',
    ['start', fmt(origin[0] + box.x0), fmt(origin[1] + box.y0)],
    ['end', fmt(origin[0] + box.x1), fmt(origin[1] + box.y1)],
    ['stroke', ['width', 0.1], ['type', 'default']],
    ['fill', 'no'],
    ['layer', q('Edge.Cuts')],
    ['uuid', q(randomUUID())],
  ]);

  return [
    'kicad_pcb',
    ['version', 20260206],
    ['generator', q('triage')],
    ['generator_version', q('0.1')],
    ...boardHeader(),
    ['title_block', ['title', q('Smart Fan')], ['company', q('Triage example (PLAN §3)')]],
    ...items,
  ];
}

// ---- Libraries the project carries ---------------------------------------------------

function projectLibraries(libs) {
  const libDir = path.join(outDir, 'libraries');
  rmSync(libDir, { recursive: true, force: true });
  mkdirSync(path.join(libDir, `${LIB}.pretty`), { recursive: true });
  const symbolLib = [
    'kicad_symbol_lib',
    ['version', 20251024],
    ['generator', q('triage')],
    ['generator_version', q('0.1')],
  ];
  for (const name of Object.keys(SYMBOLS)) symbolLib.push(libs.symbols[name]);
  writeFileSync(path.join(libDir, `${LIB}.kicad_sym`), `${print(symbolLib)}\n`);
  for (const [name, { file }] of Object.entries(libs.footprints)) {
    cpSync(file, path.join(libDir, `${LIB}.pretty`, `${name}.kicad_mod`));
  }
  writeFileSync(
    path.join(outDir, 'sym-lib-table'),
    `(sym_lib_table\n\t(version 7)\n\t(lib (name "${LIB}")(type "KiCad")(uri "\${KIPRJMOD}/libraries/${LIB}.kicad_sym")(options "")(descr "Smart Fan parts, from KiCad ${pin.tag}'s libraries"))\n)\n`,
  );
  writeFileSync(
    path.join(outDir, 'fp-lib-table'),
    `(fp_lib_table\n\t(version 7)\n\t(lib (name "${LIB}")(type "KiCad")(uri "\${KIPRJMOD}/libraries/${LIB}.pretty")(options "")(descr "Smart Fan footprints, from KiCad ${pin.tag}'s libraries"))\n)\n`,
  );
}

// ---- Main ----------------------------------------------------------------------------

function kicadCli(args) {
  const { stagedEnv, stagedProgram } = globalThis.__staged;
  return run(stagedProgram('kicad-cli'), args, {
    env: { ...process.env, ...stagedEnv() },
    capture: true,
  });
}

async function main() {
  globalThis.__staged = await import(path.join(root, 'engines', 'eda', 'stage.mjs'));
  const libs = loadLibraries();
  mkdirSync(outDir, { recursive: true });
  const rootUuid = randomUUID();
  const symbolUuids = new Map(PARTS.map((part) => [part.ref, randomUUID()]));

  projectLibraries(libs);
  const pro = {
    meta: { filename: `${PROJECT}.kicad_pro`, version: 3 },
    sheets: [[rootUuid, 'Root']],
  };
  writeFileSync(path.join(outDir, `${PROJECT}.kicad_pro`), `${JSON.stringify(pro, null, 2)}\n`);
  const schFile = path.join(outDir, `${PROJECT}.kicad_sch`);
  const pcbFile = path.join(outDir, `${PROJECT}.kicad_pcb`);
  writeFileSync(schFile, `${print(schematic(libs, rootUuid, symbolUuids))}\n`);
  writeFileSync(pcbFile, `${print(board(libs, rootUuid, symbolUuids))}\n`);

  // KiCad itself writes the final files.
  kicadCli(['sch', 'upgrade', '--force', schFile]);
  kicadCli(['pcb', 'upgrade', '--force', pcbFile]);

  const erc = path.join(cacheDir, 'smart-fan-erc.json');
  kicadCli(['sch', 'erc', '--format', 'json', '--severity-error', '--output', erc, schFile]);
  const ercErrors = JSON.parse(readFileSync(erc, 'utf8')).sheets.flatMap(
    (sheet) => sheet.violations,
  );
  const drc = path.join(cacheDir, 'smart-fan-drc.json');
  kicadCli([
    'pcb',
    'drc',
    '--format',
    'json',
    '--severity-error',
    '--schematic-parity',
    '--output',
    drc,
    pcbFile,
  ]);
  const drcReport = JSON.parse(readFileSync(drc, 'utf8'));
  console.log(
    `ERC errors: ${ercErrors.length}; DRC errors: ${drcReport.violations.length}; schematic parity: ${drcReport.schematic_parity.length}; unconnected: ${drcReport.unconnected_items.length}`,
  );
  for (const violation of [...ercErrors, ...drcReport.violations, ...drcReport.schematic_parity]) {
    console.log(`  ${violation.type}: ${violation.description}`);
  }
  if (ercErrors.length > 0 || drcReport.schematic_parity.length > 0) process.exit(1);
  console.log(`Wrote ${path.relative(process.cwd(), outDir)}.`);
}

await main();
