/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The sim engine (ROADMAP P3, PLAN §4.2): a utility process that loads Triage's
 *  simulation (the sim/ package and the Rust kernel addon, packaged in
 *  resources/app/engines/sim/), builds a project's firmware and device for a
 *  scope, runs it paced to the wall clock at a chosen speed, and publishes frames
 *  at up to 30 Hz: signal values, plotted samples, serial output and displays.
 *  Patch 0002 adds this module to the build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { ISimEngine, ISimFrame, ISimModule, ISimProject, ISimRunInfo, ISimRunner, ISimScenarioResult, ISimScope, SIM_ENGINE_CHANNEL, SimState } from '../common/sim/simService.js';

/** Virtual time per kernel call between checks of the wall clock, s. */
const CHUNK = 0.005;
/** Frames per second at most. */
const FRAME_MS = 33;
/**
 * The shortest press of a momentary control, in simulated time, s. A click lasts
 * about 0.1 s of wall time, which is less simulated time when the simulation runs
 * slower than real time, and firmware debounces buttons (the Smart Fan: 30 ms, read
 * once per loop): a release sooner than this waits (release()).
 */
const MIN_PRESS_SECONDS = 0.15;
/** Instrument samples: one per CHUNK, kept for the frame. */

export class SimEngine implements ISimEngine {
	private readonly disposables = new DisposableStore();
	private readonly _onDidFrame = this.disposables.add(new Emitter<ISimFrame>());
	readonly onDidFrame = this._onDidFrame.event;
	private readonly _onDidChangeState = this.disposables.add(new Emitter<SimState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private module: ISimModule | undefined;
	private project: ISimProject | undefined;
	private runner: ISimRunner | undefined;
	private info: ISimRunInfo | undefined;
	private state: SimState = { kind: 'idle' };
	private speed = 1;
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private immediate: ReturnType<typeof setImmediate> | undefined;
	private wallStart = 0;
	private virtualStart = 0;
	private lastFrame = 0;
	private serialSent = 0;
	private displayVersions = new Map<string, number>();
	private plots = new Map<string, number[]>();
	private ratioWall = 0;
	private ratioVirtual = 0;
	private ratio = 0;
	private signalIds = new Uint32Array();
	private signalNames: string[] = [];
	private lastTrim = 0;
	private firmwareHex: string | undefined;
	private pwmPins: { name: string; drive: string }[] = [];
	/** Simulated time of each control's last input, s. */
	private readonly inputAt = new Map<string, number>();
	/** Inputs waiting for their time (a release held to MIN_PRESS_SECONDS, and what follows it), per control. */
	private readonly queued = new Map<string, { at: number; value: number }[]>();

	async load(folder: string, project: string): Promise<{ scopes: ISimScope[]; scenarios: string[]; mujoco: boolean }> {
		if (!this.module) {
			process.env['TRIAGE_SIM_ADDON'] = join(folder, 'triage_sim.node');
			this.module = await import(pathToFileURL(join(folder, 'dist', 'index.js')).href) as ISimModule;
		}
		this.project = this.module.loadProject(project);
		const dir = join(this.project.simulationDir, 'scenarios');
		let scenarios: string[] = [];
		try {
			scenarios = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort().map(f => join(dir, f));
		} catch {
			// no scenarios folder
		}
		const version = JSON.parse(this.module.loadAddon().version()) as { mujoco?: boolean };
		return { scopes: this.module.scopes(this.project).map(s => ({ name: s.name, id: s.id, run: s.run })), scenarios, mujoco: version.mujoco === true };
	}

	private setState(state: SimState): SimState {
		this.state = state;
		this._onDidChangeState.fire(state);
		return state;
	}

	async getState(): Promise<SimState> {
		return this.state;
	}

	private requireModule(): { module: ISimModule; project: ISimProject } {
		if (!this.module || !this.project) {
			throw new Error('the simulation is not loaded');
		}
		return { module: this.module, project: this.project };
	}

	async prepare(scopeName: string): Promise<SimState> {
		await this.stop();
		const { module, project } = this.requireModule();
		try {
			const scope = module.findScope(scopeName, project);
			let firmware: string | undefined;
			if (scope.run.includes('firmware')) {
				this.setState({ kind: 'building', what: 'firmware' });
				const built = module.buildProjectFirmware(project);
				this.firmwareHex = readFileSync(built.hex, 'utf8');
				firmware = `${built.flash} bytes flash, ${built.ram} bytes RAM${built.cached ? '' : ' (just built)'}`;
			}
			this.setState({ kind: 'building', what: 'device' });
			const runner = new module.Runner({ device: module.deviceSpec(project), scope, ...(this.firmwareHex && scope.run.includes('firmware') ? { firmwareHex: this.firmwareHex } : {}) });
			this.runner = runner;
			this.inputAt.clear();
			this.queued.clear();
			const info = runner.info;
			this.signalNames = info.signals.map(s => s[0]);
			this.signalIds = Uint32Array.from(this.signalNames.map((_, i) => i));
			const device = (runner as unknown as { device: { board: { reference: string; pins: { name: string; net: string; pwm: boolean }[] } | null } }).device;
			this.pwmPins = (device.board?.pins ?? []).filter(p => p.pwm).map(p => ({ name: `${p.name} (${p.net.replace(/^\//, '')})`, drive: `${device.board!.reference}.${p.name}.drive` })).filter(p => this.signalNames.includes(p.drive));
			const plotted = this.signalNames.flatMap(name => {
				if (name === 'env:temperature_c') {
					return [{ signal: name, label: 'Room temperature', unit: '°C' }];
				}
				if (/\.current$/.test(name) && !name.startsWith('rail:')) {
					return [{ signal: name, label: `${name.split('.')[0]} current`, unit: 'A' }];
				}
				if (/\.omega$/.test(name)) {
					return [{ signal: name, label: `${name.split('.')[0]} speed`, unit: 'rpm' }];
				}
				if (name.startsWith('rail:')) {
					return [{ signal: name, label: `${name.slice(5, -8)} supply current`, unit: 'A' }];
				}
				return [];
			});
			for (const pin of this.pwmPins) {
				plotted.push({ signal: `duty:${pin.drive}`, label: `${pin.name} duty`, unit: '%' });
			}
			this.info = {
				scope: info.scope,
				units: info.units,
				stubs: info.stubs,
				leftOut: info.left_out,
				controls: info.controls,
				ioPanel: info.io_panel,
				bodies: info.bodies,
				leds: info.leds,
				displays: [...runner.displays.keys()],
				mechanicsEngine: info.mechanics_engine,
				firmware,
				plotted,
			};
			this.serialSent = 0;
			this.displayVersions.clear();
			this.plots = new Map(plotted.map(p => [p.signal, []]));
			this.lastTrim = 0;
			this.publish(true);
			return this.setState({ kind: 'ready', info: this.info });
		} catch (error) {
			this.runner = undefined;
			return this.setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	async run(speed: number): Promise<void> {
		if (!this.runner || !this.info) {
			throw new Error('prepare a scope first');
		}
		this.speed = speed;
		this.running = true;
		this.wallStart = performance.now();
		this.virtualStart = this.runner.now;
		this.ratioWall = this.wallStart;
		this.ratioVirtual = this.virtualStart;
		this.setState({ kind: 'running', info: this.info });
		this.cancelTick();
		this.tick();
	}

	async setSpeed(speed: number): Promise<void> {
		this.speed = speed;
		if (this.runner) {
			this.wallStart = performance.now();
			this.virtualStart = this.runner.now;
		}
	}

	async pause(): Promise<void> {
		this.running = false;
		this.cancelTick();
		if (this.info && this.runner) {
			this.publish(true);
			this.setState({ kind: 'paused', info: this.info });
		}
	}

	async step(seconds: number): Promise<void> {
		if (!this.runner || !this.info) {
			throw new Error('prepare a scope first');
		}
		this.running = false;
		this.cancelTick();
		const end = this.runner.now + seconds;
		while (this.runner.now < end - 1e-12) {
			this.advance(Math.min(this.runner.now + CHUNK, end));
		}
		this.publish(true);
		this.setState({ kind: 'paused', info: this.info });
	}

	async stop(): Promise<void> {
		this.running = false;
		this.cancelTick();
		this.runner = undefined;
		this.info = undefined;
		this.inputAt.clear();
		this.queued.clear();
		if (this.state.kind !== 'idle') {
			this.setState({ kind: 'idle' });
		}
	}

	async input(control: string, value: number): Promise<void> {
		this.enqueue(control, value, 0);
	}

	async release(control: string, value: number): Promise<void> {
		this.enqueue(control, value, MIN_PRESS_SECONDS);
	}

	/**
	 * Sets a control now, or `gap` s of simulated time after its last input; while one
	 * waits, later inputs to the control queue behind it, each MIN_PRESS_SECONDS
	 * later, so quick clicks stay separate presses.
	 */
	private enqueue(control: string, value: number, gap: number): void {
		const runner = this.runner;
		if (!runner) {
			return;
		}
		const queue = this.queued.get(control);
		const last = queue?.at(-1)?.at;
		const at = last !== undefined ? last + MIN_PRESS_SECONDS : (this.inputAt.get(control) ?? -Infinity) + gap;
		if (at <= runner.now) {
			this.inputAt.set(control, runner.now);
			runner.input(control, value);
		} else if (queue) {
			queue.push({ at, value });
		} else {
			this.queued.set(control, [{ at, value }]);
		}
	}

	async sendSerial(text: string): Promise<void> {
		this.runner?.avr?.sendSerial(Array.from(text, ch => ch.charCodeAt(0) & 0xff));
	}

	async runScenarios(files: readonly string[]): Promise<ISimScenarioResult[]> {
		const { module, project } = this.requireModule();
		const results: ISimScenarioResult[] = [];
		let hex: string | undefined;
		for (const file of files) {
			try {
				const scenario = module.loadScenario(file);
				if (!hex && module.findScope(scenario.scope, project).run.includes('firmware')) {
					hex = readFileSync(module.buildProjectFirmware(project).hex, 'utf8');
				}
				const r = module.runScenario(project, scenario, hex);
				results.push({
					name: r.scenario.name, file, scope: r.scenario.scope, passed: r.passed, wall: r.wall, speed: r.speed, error: r.error,
					checks: r.checks.map(c => ({ kind: c.check.kind, that: c.check.that, passed: c.passed, detail: c.detail })),
				});
			} catch (error) {
				results.push({ name: file, file, scope: '', passed: false, wall: 0, speed: 0, error: error instanceof Error ? error.message : String(error), checks: [] });
			}
		}
		return results;
	}

	/** Runs to `until` (s) and records one instrument sample. */
	private advance(until: number): void {
		const runner = this.runner!;
		// Queued inputs that fall due on the way, each at its time.
		if (this.queued.size) {
			const due = [...this.queued].flatMap(([control, queue]) => queue.map(input => ({ control, ...input })))
				.filter(input => input.at <= until)
				.sort((a, b) => a.at - b.at);
			for (const input of due) {
				runner.runUntil(input.at);
				const queue = this.queued.get(input.control)!;
				queue.shift();
				if (!queue.length) {
					this.queued.delete(input.control);
				}
				this.inputAt.set(input.control, runner.now);
				runner.input(input.control, input.value);
			}
		}
		runner.runUntil(until);
		const t = runner.now;
		for (const [signal, points] of this.plots) {
			let v: number;
			if (signal.startsWith('duty:')) {
				v = this.duty(signal.slice(5)) * 100;
			} else {
				v = runner.value(signal);
				if (signal.endsWith('.omega')) {
					v = v * 60 / (2 * Math.PI);
				}
			}
			points.push(t, v);
		}
		if (t - this.lastTrim >= 1) {
			runner.sim.trimTraces((t - 0.5) * 1e12);
			this.lastTrim = t;
		}
	}

	/** Fraction of the last 20 ms a drive signal was high. */
	private duty(drive: string): number {
		const runner = this.runner!;
		const now = runner.now;
		const from = Math.max(0, now - 0.02);
		const { t, v } = runner.trace(drive, from);
		let high = 0;
		for (let i = 0; i < t.length; i++) {
			const a = Math.max(t[i], from);
			const b = Math.min(i + 1 < t.length ? t[i + 1] : now, now);
			if (b > a && (v[i] === 1 || v[i] === 4)) {
				high += b - a;
			}
		}
		return now > from ? high / (now - from) : 0;
	}

	private tick(): void {
		if (!this.running || !this.runner) {
			return;
		}
		const started = performance.now();
		const unlimited = this.speed <= 0;
		const target = unlimited ? Infinity : this.virtualStart + (started - this.wallStart) / 1000 * this.speed;
		// Run for at most 25 ms of wall time, so pause and inputs stay responsive.
		while (this.runner.now < target && performance.now() - started < 25) {
			this.advance(Math.min(this.runner.now + CHUNK, target));
		}
		if (performance.now() - this.lastFrame >= FRAME_MS) {
			this.publish(false);
		}
		// Behind: go on at once (setImmediate still lets messages in; a 0 ms timeout
		// waits up to 15.6 ms on Windows, a third of the time). Caught up: rest a little.
		if (this.runner.now < target) {
			this.immediate = setImmediate(() => this.tick());
		} else {
			this.timer = setTimeout(() => this.tick(), 4);
		}
	}

	private cancelTick(): void {
		clearTimeout(this.timer);
		clearImmediate(this.immediate);
		this.timer = undefined;
		this.immediate = undefined;
	}

	/** Publishes a frame. */
	private publish(force: boolean): void {
		const runner = this.runner;
		if (!runner) {
			return;
		}
		const now = performance.now();
		const elapsed = (now - this.ratioWall) / 1000;
		if (elapsed >= 0.5 || force) {
			this.ratio = elapsed > 0 ? (runner.now - this.ratioVirtual) / elapsed : 0;
			this.ratioWall = now;
			this.ratioVirtual = runner.now;
		}
		this.lastFrame = now;
		const raw = runner.sim.values(this.signalIds);
		const values: Record<string, number> = {};
		this.signalNames.forEach((name, i) => values[name] = raw[i]);
		const plots: Record<string, number[]> = {};
		for (const [signal, points] of this.plots) {
			// At most 400 points a frame: keep every n-th sample.
			const n = Math.max(1, Math.ceil(points.length / 2 / 400));
			const out: number[] = [];
			for (let i = 0; i < points.length; i += 2 * n) {
				out.push(points[i], points[i + 1]);
			}
			plots[signal] = out;
			points.length = 0;
		}
		let serial = '';
		const bytes = runner.avr?.serial;
		if (bytes && bytes.length > this.serialSent) {
			serial = String.fromCharCode(...bytes.slice(this.serialSent).map(b => b.byte));
			this.serialSent = bytes.length;
			// Long runs: forget what was sent.
			if (bytes.length > 100_000) {
				bytes.splice(0, bytes.length);
				this.serialSent = 0;
			}
		}
		const displays: ISimFrame['displays'] = {};
		for (const [ref, display] of runner.displays) {
			if (force || this.displayVersions.get(ref) !== display.version) {
				this.displayVersions.set(ref, display.version);
				(displays as Record<string, { buffer: number[]; text: string; on: boolean }>)[ref] = { buffer: Array.from(display.buffer), text: display.text, on: display.on };
			}
		}
		const duty: Record<string, number> = {};
		for (const pin of this.pwmPins) {
			duty[pin.drive] = this.duty(pin.drive);
		}
		this._onDidFrame.fire({ t: runner.now, ratio: this.ratio, running: this.running, values, plots, serial, displays, duty });
	}
}

if (isUtilityProcess(process)) {
	const server = new UtilityProcessServer();
	server.registerChannel(SIM_ENGINE_CHANNEL, ProxyChannel.fromService(new SimEngine(), new DisposableStore()));
}
