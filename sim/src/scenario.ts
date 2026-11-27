// Scenario tests, YAML v0 (ROADMAP P3-6, PLAN §4.7):
//
//   name: fan reacts to overheating
//   scope: whole-device              # circuit, code, mechanism, or a saved scope's file name
//   duration: 12s
//   environment: { temperature_C: { ramp: [20, 40], over: 10s } }
//   inputs:                          # stimuli at virtual times
//     - { at: 3s, set: { SW1.pressed: 1 } }
//   expect:
//     - at: 8s
//       that: pwm_duty(net: FAN_PWM) >= 0.8
//     - within: [9s, 12s]
//       that: oled(J3).text contains "HOT"
//     - always: current(net: +12V) < 1.5A
//
// Functions: pwm_duty(net:), voltage(net:), current(net: | part:), rpm(part: | body:),
// brightness(led:), temperature(), oled(REF).text, serial, signal("name").
// Operators: < <= > >= == != contains, "not contains". Units: s ms us, V mV,
// A mA, %, rpm, C.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { deviceSpec, findScope, type Project } from './project.js';
import { Runner } from './runner.js';

export interface Check {
  readonly kind: 'at' | 'within' | 'always';
  readonly that: string;
  /** For `at`: the time; for `within`: [from, to]; for `always`: [0, duration]. */
  readonly from: number;
  readonly to: number;
}

export interface Scenario {
  readonly name: string;
  readonly file: string;
  readonly scope: string;
  readonly duration: number;
  readonly temperatureProfile: [number, number][] | undefined;
  readonly roomTemperature: number | undefined;
  readonly inputs: { at: number; control: string; value: number }[];
  readonly checks: Check[];
}

export interface CheckResult {
  readonly check: Check;
  readonly passed: boolean;
  /** What was seen (the value at the time, or where it failed). */
  readonly detail: string;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly passed: boolean;
  readonly checks: CheckResult[];
  /** Wall-clock seconds the run took. */
  readonly wall: number;
  /** Simulated seconds per wall second. */
  readonly speed: number;
  readonly error?: string;
}

const UNITS: Record<string, number> = {
  s: 1,
  ms: 1e-3,
  us: 1e-6,
  µs: 1e-6,
  V: 1,
  mV: 1e-3,
  A: 1,
  mA: 1e-3,
  '%': 0.01,
  rpm: 1,
  C: 1,
  '°C': 1,
};

/** "8s", "250ms", 1.5, "1.5A" → a number in SI units (percent as a fraction). */
export function quantity(value: unknown): number {
  if (typeof value === 'number') return value;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Zµ°%]*)\s*$/.exec(String(value));
  if (!m) throw new Error(`not a number with a unit: ${String(value)}`);
  const unit = m[2] ?? '';
  const scale = unit === '' ? 1 : UNITS[unit];
  if (scale === undefined) throw new Error(`unknown unit "${unit}" in ${String(value)}`);
  return Number(m[1]) * scale;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw new Error(`${what} must be a mapping`);
}

/**
 * PLAN §4.7 writes expectations unquoted (`that: pwm_duty(net: FAN_PWM) >= 0.8`),
 * which YAML would read as a nested mapping; quote the values of `that:` and
 * `always:` before parsing, so files look as the plan shows them.
 */
function quoteExpressions(text: string): string {
  return text.replace(
    /^(\s*(?:-\s+)?(?:that|always):[ \t]+)(?!["'])([^\n#]*?)[ \t]*$/gm,
    (_m, key: string, value: string) => `${key}${JSON.stringify(value)}`,
  );
}

/** Parses a scenario file. */
export function parseScenario(text: string, file = 'scenario.yaml'): Scenario {
  const doc = record(parseYaml(quoteExpressions(text)), file);
  const duration = quantity(doc['duration'] ?? '10s');
  const env = doc['environment'] ? record(doc['environment'], 'environment') : {};
  let temperatureProfile: [number, number][] | undefined;
  let roomTemperature: number | undefined;
  const temperature = env['temperature_C'] ?? env['temperature_c'] ?? env['room_temperature_c'];
  if (typeof temperature === 'number') roomTemperature = temperature;
  else if (temperature) {
    const t = record(temperature, 'environment.temperature_C');
    const ramp = t['ramp'];
    if (!Array.isArray(ramp) || ramp.length !== 2)
      throw new Error('temperature_C.ramp needs [from, to]');
    const start = quantity(t['from'] ?? 0);
    const over = quantity(t['over'] ?? duration);
    temperatureProfile = [
      [start, quantity(ramp[0])],
      [start + over, quantity(ramp[1])],
    ];
  }
  const inputs: Scenario['inputs'] = [];
  for (const entry of (doc['inputs'] ?? []) as unknown[]) {
    const e = record(entry, 'inputs[]');
    const at = quantity(e['at'] ?? 0);
    for (const [control, value] of Object.entries(record(e['set'], 'inputs[].set'))) {
      inputs.push({ at, control, value: quantity(value) });
    }
  }
  inputs.sort((a, b) => a.at - b.at);
  const checks: Check[] = [];
  for (const entry of (doc['expect'] ?? []) as unknown[]) {
    const e = record(entry, 'expect[]');
    if ('always' in e) {
      checks.push({ kind: 'always', that: String(e['always']), from: 0, to: duration });
    } else if ('within' in e) {
      const w = e['within'];
      if (!Array.isArray(w) || w.length !== 2) throw new Error('within needs [from, to]');
      checks.push({
        kind: 'within',
        that: String(e['that']),
        from: quantity(w[0]),
        to: quantity(w[1]),
      });
    } else if ('at' in e) {
      const at = quantity(e['at']);
      checks.push({ kind: 'at', that: String(e['that']), from: at, to: at });
    } else throw new Error(`an expectation needs at, within or always: ${JSON.stringify(e)}`);
  }
  if (checks.length === 0) throw new Error(`${file} expects nothing`);
  return {
    name: typeof doc['name'] === 'string' ? doc['name'] : path.basename(file),
    file,
    scope: typeof doc['scope'] === 'string' ? doc['scope'] : 'whole-device',
    duration,
    temperatureProfile,
    roomTemperature,
    inputs,
    checks,
  };
}

/** Reads a scenario file. */
export function loadScenario(file: string): Scenario {
  return parseScenario(readFileSync(file, 'utf8'), file);
}

// ---- expressions ----------------------------------------------------------------------

type Value = number | string;

interface Expression {
  /** The left side's value at time t (s). */
  readonly value: (runner: Runner, t: number) => Value;
  /** For `always` on a traced number: the worst value over [from, to]. */
  readonly extreme?: (runner: Runner, from: number, to: number, max: boolean) => number;
  readonly op: string;
  readonly right: Value;
}

function netSignal(runner: Runner, net: string): string {
  for (const name of [`net:${net}`, `net:/${net}`]) if (runner.has(name)) return name;
  throw new Error(`no net "${net}" in this scope`);
}

/** The board pin's drive signal for a net (`FAN_PWM` → `A1.D9.drive`). */
function driveFor(runner: Runner, net: string): string {
  const drive = runner.driveFor(net);
  if (!drive || !runner.has(drive)) throw new Error(`no board pin drives the net "${net}"`);
  return drive;
}

function signalExtreme(
  runner: Runner,
  signal: string,
  from: number,
  to: number,
  max: boolean,
): number {
  const { t, v } = runner.trace(signal, from);
  let best = max ? -Infinity : Infinity;
  for (let i = 0; i < t.length; i++) {
    if ((t[i] ?? 0) > to) break;
    const x = v[i] ?? 0;
    best = max ? Math.max(best, x) : Math.min(best, x);
  }
  return best;
}

/** Fraction of [t − window, t] a drive signal was high. */
function duty(runner: Runner, signal: string, t: number, window = 0.02): number {
  const from = Math.max(0, t - window);
  const { t: times, v } = runner.trace(signal, from);
  let high = 0;
  for (let i = 0; i < times.length; i++) {
    const a = Math.max(times[i] ?? 0, from);
    const b = Math.min(times[i + 1] ?? t, t);
    if (b > a && (v[i] === 1 || v[i] === 4)) high += b - a;
  }
  return t > from ? high / (t - from) : 0;
}

/** Parses `function(args)[.field] op value`. */
export function parseExpression(text: string): Expression {
  const m =
    /^\s*([a-z_]+)(?:\(\s*([^)]*)\))?(?:\.([a-z_]+))?\s*(not contains|contains|>=|<=|==|!=|>|<)\s*(.+?)\s*$/.exec(
      text,
    );
  if (!m) throw new Error(`can't read the expectation "${text}"`);
  const [, fn = '', rawArgs = '', field, op = '', rawRight = ''] = m;
  const args: Record<string, string> = {};
  let positional = '';
  for (const part of rawArgs
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)) {
    const kv = /^([a-z_]+)\s*:\s*(.+)$/.exec(part);
    if (kv?.[1]) args[kv[1]] = (kv[2] ?? '').replace(/^"|"$/g, '');
    else positional = part.replace(/^"|"$/g, '');
  }
  const quoted = /^"(.*)"$/.exec(rawRight);
  const right: Value = quoted ? (quoted[1] ?? '') : quantity(rawRight);
  const signalBacked = (
    signal: (r: Runner) => string,
    scale = 1,
  ): Pick<Expression, 'value' | 'extreme'> => ({
    value: (r) => r.value(signal(r)) * scale,
    extreme: (r, from, to, max) => signalExtreme(r, signal(r), from, to, max) * scale,
  });
  let left: Pick<Expression, 'value' | 'extreme'>;
  switch (fn) {
    case 'pwm_duty': {
      const net = args['net'] ?? positional;
      left = { value: (r, t) => duty(r, driveFor(r, net), t) };
      break;
    }
    case 'voltage':
      left = signalBacked((r) => netSignal(r, args['net'] ?? positional));
      break;
    case 'current': {
      const part = args['part'];
      const net = args['net'] ?? positional;
      left = signalBacked((r) => {
        if (part) return `${part}.current`;
        for (const name of [`rail:${net}.current`, `rail:/${net}.current`])
          if (r.has(name)) return name;
        throw new Error(`"${net}" is not a supply rail; use current(part: …) for a part`);
      });
      break;
    }
    case 'rpm': {
      const part = args['part'];
      const body = args['body'];
      left = signalBacked(
        (r) => {
          if (part) return `${part}.omega`;
          const motor = r.info.bodies.find((b) => b.name === body);
          if (!motor) throw new Error(`no body "${body ?? positional}"`);
          const device = r.info.signals.find(([n]) => n.endsWith('.omega'))?.[0];
          if (!device) throw new Error('no motor turns a body');
          return device;
        },
        60 / (2 * Math.PI),
      );
      break;
    }
    case 'brightness':
      left = signalBacked(() => `${args['led'] ?? positional}.brightness`);
      break;
    case 'temperature':
      left = signalBacked(() => 'env:temperature_c');
      break;
    case 'signal':
      left = signalBacked(() => positional);
      break;
    case 'oled': {
      if (field !== 'text') throw new Error('oled(REF) has .text');
      const ref = positional || 'J3';
      left = {
        value: (r) => {
          const display = r.displays.get(ref);
          if (!display) throw new Error(`no display "${ref}" (the scope must run the firmware)`);
          return display.text;
        },
      };
      break;
    }
    case 'serial':
      left = { value: (r) => r.serialText };
      break;
    default:
      throw new Error(`unknown function "${fn}" in "${text}"`);
  }
  return { ...left, op, right };
}

function compare(left: Value, op: string, right: Value): boolean {
  if (op === 'contains') return String(left).includes(String(right));
  if (op === 'not contains') return !String(left).includes(String(right));
  const a = Number(left);
  const b = Number(right);
  switch (op) {
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '==':
      return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) || left === right;
    default:
      return a !== b;
  }
}

function show(value: Value): string {
  return typeof value === 'number'
    ? Number(value.toPrecision(4)).toString()
    : JSON.stringify(value);
}

// ---- running ---------------------------------------------------------------------------

/** Runs a scenario on a project. `firmwareHex` is needed when its scope runs the firmware. */
export function runScenario(
  project: Project,
  scenario: Scenario,
  firmwareHex?: string,
): ScenarioResult {
  const started = performance.now();
  const scope = findScope(scenario.scope, project);
  const device = deviceSpec(project, {
    ...(scenario.roomTemperature !== undefined
      ? { room_temperature_c: scenario.roomTemperature }
      : {}),
    ...(scenario.temperatureProfile ? { temperature_profile: scenario.temperatureProfile } : {}),
  });
  const needsFirmware = scope.run.includes('firmware');
  const runner = new Runner({
    device,
    scope,
    ...(needsFirmware && firmwareHex ? { firmwareHex } : {}),
  });
  const expressions = scenario.checks.map((c) => parseExpression(c.that));
  const results: (CheckResult | undefined)[] = scenario.checks.map(() => undefined);
  const satisfied = scenario.checks.map(() => false);

  const step = 0.005;
  const inputs = [...scenario.inputs];
  for (let t = step; t <= scenario.duration + 1e-9; t += step) {
    while (inputs[0] && inputs[0].at <= t - step + 1e-12) {
      const input = inputs.shift();
      if (input) runner.input(input.control, input.value);
    }
    runner.runUntil(t);
    scenario.checks.forEach((check, i) => {
      const e = expressions[i];
      if (!e || results[i]) return;
      if (check.kind === 'at' && t + 1e-9 >= check.from) {
        const v = e.value(runner, check.from);
        results[i] = {
          check,
          passed: compare(v, e.op, e.right),
          detail: `${show(v)} at ${check.from} s`,
        };
      } else if (check.kind === 'within' && t + 1e-9 >= check.from && t <= check.to + 1e-9) {
        const v = e.value(runner, t);
        if (compare(v, e.op, e.right)) {
          satisfied[i] = true;
          results[i] = { check, passed: true, detail: `${show(v)} at ${t.toFixed(3)} s` };
        } else if (t + step > check.to + 1e-9) {
          results[i] = {
            check,
            passed: false,
            detail: `never between ${check.from} and ${check.to} s (last ${show(v)})`,
          };
        }
      } else if (check.kind === 'always') {
        const from = t - step;
        const max = e.op === '<' || e.op === '<=';
        const v =
          e.extreme && typeof e.right === 'number' && e.op !== '==' && e.op !== '!='
            ? e.extreme(runner, from, t, max)
            : e.value(runner, t);
        if (!compare(v, e.op, e.right)) {
          results[i] = { check, passed: false, detail: `${show(v)} at ${t.toFixed(3)} s` };
        }
      }
    });
    // Keep traces short: the checks only look back one PWM window.
    if (Math.round(t / step) % 200 === 0) runner.sim.trimTraces((t - 0.1) * 1e12);
  }
  const checks = scenario.checks.map(
    (check, i): CheckResult =>
      results[i] ?? {
        check,
        passed: check.kind === 'always',
        detail: check.kind === 'always' ? 'held' : 'not reached',
      },
  );
  const wall = (performance.now() - started) / 1000;
  return {
    scenario,
    passed: checks.every((c) => c.passed),
    checks,
    wall,
    speed: scenario.duration / wall,
  };
}

/** A result as text, one line per check. */
export function formatResult(result: ScenarioResult): string {
  const lines = [
    `${result.passed ? 'PASS' : 'FAIL'} ${result.scenario.name} (${path.basename(result.scenario.file)}, scope ${result.scenario.scope}, ${result.scenario.duration} s in ${result.wall.toFixed(1)} s, ${result.speed.toFixed(1)}× real time)`,
  ];
  if (result.error) lines.push(`  error: ${result.error}`);
  for (const c of result.checks) {
    const when =
      c.check.kind === 'at'
        ? `at ${c.check.from} s`
        : c.check.kind === 'within'
          ? `within ${c.check.from}–${c.check.to} s`
          : 'always';
    lines.push(`  ${c.passed ? '✓' : '✗'} ${when}: ${c.check.that} — ${c.detail}`);
  }
  return lines.join('\n');
}
