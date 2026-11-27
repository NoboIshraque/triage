// A Triage project as the simulation sees it (ROADMAP P3-3 to P3-6): triage.toml,
// the link graph (.triage/links.json, written by Triage from KiCad's engine),
// simulation/parts.toml, environment.toml, scopes/*.toml and scenarios/*.yaml,
// turned into the device description the Rust kernel builds (crates/triage-sim,
// spec.rs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { board as boardProfile } from './boards.js';

export interface LinksPin {
  readonly number: string;
  readonly name: string;
  readonly net: string;
}
export interface LinksComponent {
  readonly reference: string;
  readonly symbol: string;
  readonly value: string;
  readonly footprint: string;
  readonly pins: readonly LinksPin[];
}
export interface Links {
  readonly format: number;
  readonly board: { readonly profile: string; readonly symbol: string };
  readonly components: readonly LinksComponent[];
  readonly nets: readonly {
    readonly name: string;
    readonly pins: readonly string[];
    readonly firmware?: {
      readonly constant: string;
      readonly pin: string;
      readonly number: number;
    };
  }[];
}

/** crates/triage-sim/src/spec.rs, as JSON. */
export interface PartSpec {
  reference: string;
  model: string;
  params: Record<string, number>;
  pins: Record<string, string>;
}
export interface BoardPinSpec {
  name: string;
  net: string;
  analog: boolean;
  pwm: boolean;
}
export interface BoardSpec {
  reference: string;
  profile: string;
  pins: BoardPinSpec[];
  regulator: { net: string; volts: number } | null;
  vin: string | null;
  quiescent_a: number;
}
export interface BodySpec {
  name: string;
  driven_by: string;
  radius_m?: number;
  mass_kg?: number;
  damping?: number;
  drag?: number;
  object?: string;
  axis?: [number, number, number];
  origin?: [number, number, number];
}
export interface DeviceSpec {
  name: string;
  ground: string;
  board: BoardSpec | null;
  parts: PartSpec[];
  environment: { room_temperature_c: number; temperature_profile: [number, number][] };
  mechanics: BodySpec[];
}

export interface ScopeSpec {
  name: string;
  /** A saved scope's file name without `.toml` (`power-stage`). */
  id?: string;
  run: string[];
  stubs: Record<string, unknown>;
}

export interface Project {
  readonly root: string;
  readonly name: string;
  readonly board: string;
  /** The board for builds and uploads (arduino-cli's FQBN), when triage.toml names one. */
  readonly fqbn?: string;
  /** Arduino libraries the firmware uses, `Name@version` (triage.toml `firmware.libraries`). */
  readonly libraries: readonly string[];
  readonly firmwareDir: string;
  readonly simulationDir: string;
  readonly mechanicalDir: string;
  readonly links: Links;
  readonly partsFile: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
}

function readToml(file: string): Record<string, unknown> {
  return existsSync(file) ? parseToml(readFileSync(file, 'utf8')) : {};
}

function section(table: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = table[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** What a project's firmware build needs (triage.toml's [firmware]), without the link graph. */
export interface FirmwareConfig {
  readonly root: string;
  readonly name: string;
  readonly board: string;
  readonly fqbn?: string;
  readonly libraries: readonly string[];
  readonly firmwareDir: string;
}

export function loadFirmwareConfig(folder: string): FirmwareConfig {
  const root = path.resolve(folder);
  const manifest = readToml(path.join(root, 'triage.toml'));
  if (!manifest['project']) throw new Error(`${root} has no triage.toml`);
  const firmware = section(manifest, 'firmware');
  return {
    root,
    name: str(section(manifest, 'project')['name'], path.basename(root)),
    board: str(firmware['board'], 'arduino-uno'),
    ...(typeof firmware['fqbn'] === 'string' ? { fqbn: firmware['fqbn'] } : {}),
    libraries: Array.isArray(firmware['libraries'])
      ? firmware['libraries'].filter((l): l is string => typeof l === 'string')
      : [],
    firmwareDir: path.join(root, str(firmware['path'], 'firmware')),
  };
}

/** Loads a project's simulation inputs. */
export function loadProject(folder: string): Project {
  const root = path.resolve(folder);
  const manifest = readToml(path.join(root, 'triage.toml'));
  if (!manifest['project']) throw new Error(`${root} has no triage.toml`);
  const firmware = section(manifest, 'firmware');
  const simulation = section(manifest, 'simulation');
  const mechanical = section(manifest, 'mechanical');
  const linksFile = path.join(root, '.triage', 'links.json');
  const hasElectronics = manifest['electronics'] !== undefined;
  if (!existsSync(linksFile) && hasElectronics) {
    throw new Error(
      `${linksFile} is missing: open the project in Triage once, and it writes the link graph from the schematic`,
    );
  }
  // A project without electronics (an Arduino example, ROADMAP PA-6) is the board
  // alone: its code runs on its own, with the virtual I/O panel.
  const links: Links = existsSync(linksFile)
    ? (JSON.parse(readFileSync(linksFile, 'utf8')) as Links)
    : {
        format: 1,
        board: { profile: str(firmware['board'], 'arduino-uno'), symbol: '' },
        components: [],
        nets: [],
      };
  if (links.format < 1) {
    throw new Error(
      `${linksFile} is format ${links.format}; the simulation needs format 1 (open the project in Triage to update it)`,
    );
  }
  const simulationDir = path.join(root, str(simulation['path'], 'simulation'));
  return {
    root,
    name: str(section(manifest, 'project')['name'], path.basename(root)),
    board: str(firmware['board'], links.board.profile),
    ...(typeof firmware['fqbn'] === 'string' ? { fqbn: firmware['fqbn'] } : {}),
    libraries: Array.isArray(firmware['libraries'])
      ? firmware['libraries'].filter((l): l is string => typeof l === 'string')
      : [],
    firmwareDir: path.join(root, str(firmware['path'], 'firmware')),
    simulationDir,
    mechanicalDir: path.join(root, str(mechanical['path'], 'mechanical')),
    links,
    partsFile: readToml(path.join(simulationDir, 'parts.toml')),
    environment: readToml(path.join(simulationDir, 'environment.toml')),
  };
}

const SI: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

/** A component value with an SI prefix: "10k", "4k7", "4.7k", "220", "100n", "12V in". */
export function parseValue(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([pnuµmkKMG])?(\d+)?/.exec(value);
  if (!m) return undefined;
  const [, whole = '', prefix, fraction] = m;
  const digits = fraction ? `${whole}.${fraction}` : whole;
  return Number(digits) * (prefix ? (SI[prefix] ?? 1) : 1);
}

/** Known MOSFETs: level-1 parameters near their datasheets' curves. */
const NMOS: Record<string, Record<string, number>> = {
  IRLZ44N: { vth: 1.5, k: 13, lambda: 0.01 },
  IRLZ34N: { vth: 1.5, k: 8, lambda: 0.01 },
  IRF540N: { vth: 3.0, k: 6, lambda: 0.01 },
  '2N7000': { vth: 2.1, k: 0.2, lambda: 0.02 },
  BS170: { vth: 2.1, k: 0.25, lambda: 0.02 },
  AO3400: { vth: 1.1, k: 20, lambda: 0.01 },
};

/** The model of a component from its symbol and value, or none (headers need parts.toml). */
export function inferPart(component: LinksComponent): Omit<PartSpec, 'reference'> | undefined {
  const symbol = component.symbol.split(':').pop() ?? '';
  const value = component.value;
  const pin = (map: Record<string, string>) => {
    const pins: Record<string, string> = {};
    for (const p of component.pins) {
      const role = map[p.number];
      if (role && p.net) pins[role] = p.net;
    }
    return pins;
  };
  if (symbol === 'PWR_FLAG' || component.reference.startsWith('#')) return undefined;
  if (/thermistor|ntc/i.test(symbol) || /ntc/i.test(value)) {
    return {
      model: 'ntc',
      params: { r25: parseValue(value) ?? 10_000, beta: 3950 },
      pins: pin({ '1': 'a', '2': 'b' }),
    };
  }
  if (symbol.startsWith('R_Pot')) {
    return {
      model: 'pot',
      params: { ohms: parseValue(value) ?? 10_000 },
      pins: pin({ '1': 'a', '2': 'wiper', '3': 'b' }),
    };
  }
  if (/^R(_|$)/.test(symbol)) {
    const ohms = parseValue(value);
    return ohms === undefined
      ? undefined
      : { model: 'resistor', params: { ohms }, pins: pin({ '1': 'a', '2': 'b' }) };
  }
  if (symbol.startsWith('SW_Push'))
    return { model: 'button', params: {}, pins: pin({ '1': 'a', '2': 'b' }) };
  if (symbol.startsWith('LED'))
    return { model: 'led', params: {}, pins: pin({ '1': 'cathode', '2': 'anode' }) };
  if (/^D(_|$)/.test(symbol))
    return { model: 'diode', params: {}, pins: pin({ '1': 'cathode', '2': 'anode' }) };
  const mos = /^Q_NMOS_([GDS]{3})$/.exec(symbol);
  if (mos?.[1]) {
    const map: Record<string, string> = {};
    const roles = mos[1];
    for (let i = 0; i < roles.length; i++) map[String(i + 1)] = roles.charAt(i).toLowerCase();
    const known = Object.entries(NMOS).find(([name]) => value.toUpperCase().startsWith(name));
    return {
      model: 'nmos',
      params: { ...(known?.[1] ?? { vth: 2, k: 1, lambda: 0.01 }) },
      pins: pin(map),
    };
  }
  if (/^C(_|$)/.test(symbol)) {
    const farads = parseValue(value);
    return farads === undefined
      ? undefined
      : { model: 'capacitor', params: { farads }, pins: pin({ '1': 'a', '2': 'b' }) };
  }
  if (/^L(_|$)/.test(symbol)) {
    const henries = parseValue(value);
    return henries === undefined
      ? undefined
      : { model: 'inductor', params: { henries }, pins: pin({ '1': 'a', '2': 'b' }) };
  }
  if (symbol.startsWith('Barrel_Jack')) {
    return {
      model: 'supply',
      params: { volts: parseValue(value) ?? 12 },
      pins: pin({ '1': '+', '2': '-' }),
    };
  }
  return undefined;
}

function boardPinName(name: string): string | undefined {
  return name.split('/').find((part) => /^[AD]\d+$/.test(part));
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/** The device description of a project (overrides: a scenario's environment). */
export function deviceSpec(
  project: Project,
  environment: Partial<DeviceSpec['environment']> = {},
): DeviceSpec {
  const { links } = project;
  const profile = boardProfile(project.board);
  const overrides = section(project.partsFile, 'parts');
  const boardComponent = links.components.find((c) => c.reference === links.board.symbol);
  let ground = '';
  let board: BoardSpec | null = null;
  if (boardComponent) {
    const pins: BoardPinSpec[] = [];
    let regulator: BoardSpec['regulator'] = null;
    let vin: string | null = null;
    for (const p of boardComponent.pins) {
      if (!p.net) continue;
      const io = boardPinName(p.name);
      if (io && profile.pins[io]) {
        if (!pins.some((q) => q.name === io)) {
          pins.push({
            name: io,
            net: p.net,
            analog: io.startsWith('A'),
            pwm: profile.pwm.includes(io),
          });
        }
      } else if (p.name === '+5V') regulator = { net: p.net, volts: 5 };
      else if (p.name === 'VIN') vin = p.net;
      else if (p.name === 'GND') ground = p.net;
    }
    const order = Object.keys(profile.pins);
    pins.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    board = {
      reference: boardComponent.reference,
      profile: profile.id,
      pins,
      regulator,
      vin,
      quiescent_a: 0.045,
    };
  }
  if (!ground) ground = links.nets.find((n) => /(^|\/)GND$/.test(n.name))?.name ?? 'GND';

  const parts: PartSpec[] = [];
  for (const component of links.components) {
    if (component.reference === links.board.symbol) continue;
    const override = section(overrides, component.reference);
    const inferred = inferPart(component);
    const model = str(override['model'], inferred?.model ?? '');
    if (!model || model === 'none') continue;
    let pins = inferred?.model === model ? inferred.pins : {};
    if (override['pins']) {
      pins = {};
      const map = override['pins'] as Record<string, string>;
      for (const p of component.pins) {
        const role = map[p.number];
        if (role && p.net) pins[role] = p.net;
      }
    }
    const params = {
      ...(inferred?.model === model ? inferred.params : {}),
      ...numbers(override['params']),
    };
    parts.push({ reference: component.reference, model, params, pins });
  }
  parts.sort((a, b) => a.reference.localeCompare(b.reference, 'en', { numeric: true }));

  const mechanics = (
    Array.isArray(project.partsFile['mechanics']) ? project.partsFile['mechanics'] : []
  ) as BodySpec[];
  const room = project.environment['room_temperature_c'];
  return {
    name: project.name,
    ground,
    board,
    parts,
    environment: {
      room_temperature_c: environment.room_temperature_c ?? (typeof room === 'number' ? room : 24),
      temperature_profile: environment.temperature_profile ?? [],
    },
    mechanics,
  };
}

/** The scopes every project has, then the project's own (simulation/scopes/*.toml). */
export function scopes(project?: Project): ScopeSpec[] {
  const builtIn: ScopeSpec[] = [
    {
      name: 'Whole device',
      run: ['firmware', 'circuit', 'mechanics', 'environment', 'parts'],
      stubs: {},
    },
    { name: 'Circuit only', run: ['circuit', 'environment'], stubs: {} },
    { name: 'Code only', run: ['firmware', 'parts'], stubs: {} },
    { name: 'Mechanism only', run: ['mechanics'], stubs: {} },
  ];
  const dir = project ? path.join(project.simulationDir, 'scopes') : '';
  if (!project || !existsSync(dir)) return builtIn;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.toml'))
    .sort()) {
    const scope = readToml(path.join(dir, file));
    builtIn.push({
      id: path.basename(file, '.toml'),
      name: str(scope['name'], path.basename(file, '.toml')),
      run: Array.isArray(scope['run']) ? (scope['run'] as string[]) : [],
      stubs: section(scope, 'stubs'),
    });
  }
  return builtIn;
}

/** A scope by name, or by the short names scenarios use (`whole-device`, `code`, a file name). */
export function findScope(name: string, project?: Project): ScopeSpec {
  const all = scopes(project);
  const key = name.toLowerCase().replace(/[\s_]+/g, '-');
  const alias: Record<string, string> = {
    'whole-device': 'Whole device',
    device: 'Whole device',
    circuit: 'Circuit only',
    'circuit-only': 'Circuit only',
    code: 'Code only',
    'code-only': 'Code only',
    mechanism: 'Mechanism only',
    'mechanism-only': 'Mechanism only',
  };
  const target = alias[key] ?? name;
  const scope =
    all.find((s) => s.name === target || s.id === name) ??
    all.find((s) => s.name.toLowerCase().replace(/[\s_]+/g, '-') === key);
  if (!scope) throw new Error(`no scope "${name}" (${all.map((s) => s.name).join(', ')})`);
  return scope;
}
