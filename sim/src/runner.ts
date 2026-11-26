// A simulation run (ROADMAP P3-2 to P3-6): the Rust kernel with the device built
// for a scope, the AVR unit as its host when the scope runs the firmware, and the
// bus devices (SSD1306 displays). The same runner serves the app's Sim tab (in
// the sim engine's utility process), the `triage test` CLI and the tests.
import { loadAddon, PS_PER_S, type NativeSimulation } from './addon.js';
import { AvrUnit, type HostPin } from './avr.js';
import { board as boardProfile } from './boards.js';
import { parseHex, programWords } from './hex.js';
import type { DeviceSpec, ScopeSpec } from './project.js';
import { Ssd1306 } from './ssd1306.js';

/** crates/triage-sim/src/device.rs `DeviceInfo`, as JSON. */
export interface DeviceInfo {
  scope: string;
  units: [string, string, string][];
  hosts: { host: number; reference: string; profile: string; pins: HostPin[] }[];
  stubs: { signal: string; kind: string }[];
  left_out: string[];
  controls: string[];
  io_panel: {
    kind: 'button' | 'slider' | 'indicator';
    label: string;
    control: string | null;
    signal: string | null;
    min: number;
    max: number;
    value: number;
    pressed: number;
  }[];
  signals: [string, 'logic' | 'real'][];
  bodies: {
    name: string;
    object: string | null;
    axis: number[];
    origin: number[];
    angle: string;
  }[];
  leds: [string, string][];
  mechanics_engine: string;
}

export interface RunnerOptions {
  readonly device: DeviceSpec;
  readonly scope: ScopeSpec;
  /** The firmware's Intel HEX text (needed when the scope runs the firmware). */
  readonly firmwareHex?: string;
  /** Step the mechanism with MuJoCo when the addon has it (default true). */
  readonly mujoco?: boolean;
  /** Trace every signal (default true; scenario checks and plots need it). */
  readonly trace?: boolean;
  /** Kernel settings, µs. */
  readonly quantumMaxUs?: number;
  readonly couplingStepUs?: number;
}

export class Runner {
  readonly sim: NativeSimulation;
  readonly info: DeviceInfo;
  readonly device: DeviceSpec;
  readonly avr: AvrUnit | undefined;
  /** Displays by reference (`J3`). */
  readonly displays = new Map<string, Ssd1306>();
  private readonly ids = new Map<string, number>();

  constructor(options: RunnerOptions) {
    const addon = loadAddon();
    const { scope } = options;
    this.device = options.device;
    this.sim = new addon.Simulation(
      JSON.stringify(options.device),
      JSON.stringify({ name: scope.name, run: scope.run, stubs: scope.stubs }),
      JSON.stringify({
        mujoco: options.mujoco ?? true,
        trace: options.trace ?? true,
        quantumMaxUs: options.quantumMaxUs ?? 1000,
        couplingStepUs: options.couplingStepUs ?? 50,
      }),
    );
    this.info = JSON.parse(this.sim.info()) as DeviceInfo;
    this.info.signals.forEach(([name], id) => this.ids.set(name, id));
    const host = this.info.hosts[0];
    if (host) {
      if (!options.firmwareHex)
        throw new Error(`the scope "${scope.name}" runs the firmware, but no firmware was given`);
      const profile = boardProfile(host.profile);
      for (const part of options.device.parts.filter((p) => p.model === 'ssd1306')) {
        this.displays.set(part.reference, new Ssd1306(part.params['address'] ?? 0x3c));
      }
      const program = programWords(parseHex(options.firmwareHex, profile.flashBytes));
      this.avr = new AvrUnit(program, profile, host.pins, [...this.displays.values()]);
    }
  }

  /** Virtual time, s. */
  get now(): number {
    return this.sim.now() / PS_PER_S;
  }

  /** Runs to `seconds` of virtual time. */
  runUntil(seconds: number): void {
    const until = seconds * PS_PER_S;
    if (!this.avr) {
      if (this.sim.now() < until) this.sim.runUntil(until);
      return;
    }
    const empty = new Float64Array();
    while (this.sim.now() < until) {
      const grant = this.sim.grant();
      const end = Math.min(grant[1] ?? until, until);
      const { reached, events } = this.avr.run(end);
      const unblock = this.sim.complete(0, reached, events.length ? events : empty);
      this.avr.apply(unblock);
    }
  }

  /** Runs `seconds` more. */
  runFor(seconds: number): void {
    this.runUntil(this.now + seconds);
  }

  /** Sets a control (`SW1.pressed`, `env.room_temperature_c`, `net:/BUTTON.value`) now. */
  input(control: string, value: number): void {
    this.sim.input(this.sim.now(), control, value);
  }

  /** A signal's value now. */
  value(signal: string): number {
    const v = this.sim.value(signal);
    if (v === null)
      throw new Error(`no signal "${signal}" (${this.info.signals.map((s) => s[0]).join(', ')})`);
    return v;
  }

  /** The drive signal of the board pin on a net (`FAN_PWM` → `A1.D9.drive`), if any. */
  driveFor(net: string): string | undefined {
    const board = this.device.board;
    const pin = board?.pins.find((p) => p.net === net || p.net === `/${net}`);
    return board && pin ? `${board.reference}.${pin.name}.drive` : undefined;
  }

  /** Whether the device has a signal. */
  has(signal: string): boolean {
    return this.ids.has(signal);
  }

  /** A signal's changes from `fromSeconds` on: times in s, values. */
  trace(signal: string, fromSeconds = 0): { t: Float64Array; v: Float64Array } {
    const raw = this.sim.trace(signal, fromSeconds * PS_PER_S);
    const n = raw.length / 2;
    const t = new Float64Array(n);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = (raw[2 * i] ?? 0) / PS_PER_S;
      v[i] = raw[2 * i + 1] ?? 0;
    }
    return { t, v };
  }

  /** The firmware's serial output so far. */
  get serialText(): string {
    return this.avr?.serialText() ?? '';
  }

  /** Readouts of every unit. */
  readouts(): Record<string, number> {
    return JSON.parse(this.sim.readouts()) as Record<string, number>;
  }
}
