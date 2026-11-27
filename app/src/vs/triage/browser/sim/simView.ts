/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Sim tab (ROADMAP P3-2, P3-5; PLAN §3 step 6, §4.7): Run / Pause / Step /
 *  Stop and the speed; the scope picker (whole device, circuit only, code only,
 *  mechanism only, the project's saved scopes); the environment panel (room
 *  temperature) and the parts' controls (buttons, pots); the virtual I/O panel
 *  when only the code runs; the stubs at the scope's boundary; instruments v0
 *  (plots of temperatures, currents, speeds and PWM duty, the OLED, the serial
 *  monitor); and the project's scenarios with their results.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../platform/commands/common/commands.js';
import { ARDUINO_COMMANDS } from '../../common/arduino/arduino.js';
import { $, addDisposableListener, append, EventType, getWindow, reset } from '../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { basename } from '../../../base/common/path.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ISimFrame, ISimRunInfo, ISimScenarioResult, ISimScope, ITriageSimService, SimState } from '../../common/sim/simService.js';

const COLOURS = ['#4fc1ff', '#f4b860', '#9cdc6c', '#f07178', '#c792ea', '#80cbc4', '#ffcb6b'];
const SPEEDS: [string, number][] = [['0.25×', 0.25], ['0.5×', 0.5], ['1×', 1], ['2×', 2], ['4×', 4], [localize('triage.sim.max', "max"), 0]];
/** Seconds of history the plots keep. */
const PLOT_SECONDS = 10;

interface Series {
	readonly label: string;
	readonly unit: string;
	readonly colour: string;
	t: number[];
	v: number[];
}

export class SimView extends Disposable {
	readonly element: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly scopeSelect: HTMLSelectElement;
	private readonly speedSelect: HTMLSelectElement;
	private readonly runButton: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly controls: HTMLElement;
	private readonly plotCanvas: HTMLCanvasElement;
	private readonly legend: HTMLElement;
	private readonly oledCanvas: HTMLCanvasElement;
	private readonly oledBox: HTMLElement;
	private readonly serialOut: HTMLElement;
	private readonly scenarioList: HTMLElement;
	private readonly panelDisposables = this._register(new DisposableStore());
	private readonly indicators = new Map<string, HTMLElement>();
	private series = new Map<string, Series>();
	private scopes: readonly ISimScope[] = [];
	private scenarios: readonly string[] = [];
	private info: ISimRunInfo | undefined;
	private serialText = '';
	private plotRequested = false;

	constructor(
		@ITriageSimService private readonly sim: ITriageSimService,
		@ILogService private readonly logService: ILogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.triage-sim-view');
		this.element.tabIndex = 0;
		this.element.dataset['state'] = 'idle';

		this.toolbar = append(this.element, $('.triage-sim-toolbar'));
		this.runButton = this.button(this.toolbar, localize('triage.sim.run', "Run"), () => this.toggleRun(), 'run');
		this.button(this.toolbar, localize('triage.sim.step', "Step 10 ms"), () => this.step(), 'step');
		this.button(this.toolbar, localize('triage.sim.stop', "Stop"), () => this.sim.stop(), 'stop');
		// ROADMAP PA-1: Build (and Upload) here too, not only above the code; Run builds by itself.
		this.button(this.toolbar, localize('triage.sim.build', "Build"), () => this.commandService.executeCommand(ARDUINO_COMMANDS.build), 'build');
		this.button(this.toolbar, localize('triage.sim.upload', "Upload"), () => this.commandService.executeCommand(ARDUINO_COMMANDS.upload), 'upload');
		append(this.toolbar, $('span.triage-sim-label', undefined, localize('triage.sim.scope', "Scope")));
		this.scopeSelect = append(this.toolbar, $('select.triage-sim-scope')) as HTMLSelectElement;
		this.scopeSelect.title = localize('triage.sim.scopeTitle', "What runs: the whole device, or one part with stubs for the rest (PLAN §4.7)");
		this._register(addDisposableListener(this.scopeSelect, EventType.CHANGE, () => void this.sim.stop()));
		append(this.toolbar, $('span.triage-sim-label', undefined, localize('triage.sim.speed', "Speed")));
		this.speedSelect = append(this.toolbar, $('select.triage-sim-speed')) as HTMLSelectElement;
		for (const [label, value] of SPEEDS) {
			const option = append(this.speedSelect, $('option')) as HTMLOptionElement;
			option.value = String(value);
			option.textContent = label;
			option.selected = value === 1;
		}
		this._register(addDisposableListener(this.speedSelect, EventType.CHANGE, () => void this.sim.setSpeed(this.speed)));
		this.status = append(this.toolbar, $('span.triage-sim-status'));

		const body = append(this.element, $('.triage-sim-body'));
		this.controls = append(body, $('.triage-sim-controls'));
		const instruments = append(body, $('.triage-sim-instruments'));
		append(instruments, $('h3', undefined, localize('triage.sim.instruments', "Instruments")));
		this.plotCanvas = append(instruments, $('canvas.triage-sim-plot')) as HTMLCanvasElement;
		this.legend = append(instruments, $('.triage-sim-legend'));
		this.oledBox = append(instruments, $('.triage-sim-oled'));
		append(this.oledBox, $('h3', undefined, localize('triage.sim.oled', "Display")));
		this.oledCanvas = append(this.oledBox, $('canvas')) as HTMLCanvasElement;
		this.oledCanvas.width = 128;
		this.oledCanvas.height = 64;
		append(instruments, $('h3', undefined, localize('triage.sim.serial', "Serial monitor (115200 baud)")));
		this.serialOut = append(instruments, $('pre.triage-sim-serial'));
		const serialIn = append(instruments, $('.triage-sim-serial-input'));
		const input = append(serialIn, $('input')) as HTMLInputElement;
		input.placeholder = localize('triage.sim.serialPlaceholder', "Send to the board…");
		const send = () => {
			void this.sim.sendSerial(`${input.value}\n`);
			input.value = '';
		};
		this.button(serialIn, localize('triage.sim.send', "Send"), send, 'send');
		this._register(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				send();
			}
		}));
		append(instruments, $('h3', undefined, localize('triage.sim.scenarios', "Scenarios")));
		this.scenarioList = append(instruments, $('.triage-sim-scenarios'));

		this._register(this.sim.onDidChangeState(state => this.onState(state)));
		this._register(this.sim.onDidFrame(frame => this.onFrame(frame)));
		this.onState(this.sim.state);
		if (this.sim.lastFrame) {
			this.onFrame(this.sim.lastFrame);
		}
		void this.load();
	}

	private button(parent: HTMLElement, label: string, run: () => unknown, action: string): HTMLButtonElement {
		const button = append(parent, $('button.triage-sim-button')) as HTMLButtonElement;
		button.textContent = label;
		button.dataset['action'] = action;
		this._register(addDisposableListener(button, EventType.CLICK, () => {
			Promise.resolve(run()).catch(error => this.showError(error));
		}));
		return button;
	}

	private get speed(): number {
		return Number(this.speedSelect.value);
	}

	/** Loads the project's scopes and scenarios. */
	async load(): Promise<void> {
		try {
			const { scopes, scenarios, mujoco } = await this.sim.load();
			this.scopes = scopes;
			this.scenarios = scenarios;
			const current = this.scopeSelect.value;
			reset(this.scopeSelect);
			for (const scope of scopes) {
				const option = append(this.scopeSelect, $('option')) as HTMLOptionElement;
				option.value = scope.id ?? scope.name;
				option.textContent = scope.name;
				option.title = localize('triage.sim.runs', "Runs: {0}", scope.run.join(', '));
				option.selected = option.value === current;
			}
			this.element.dataset['mujoco'] = String(mujoco);
			this.renderScenarios([]);
			this.element.dataset['loaded'] = 'true';
		} catch (error) {
			this.showError(error);
		}
	}

	private async toggleRun(): Promise<void> {
		const state = this.sim.state;
		if (state.kind === 'running') {
			await this.sim.pause();
		} else if (state.kind === 'paused' || state.kind === 'ready') {
			await this.sim.run(this.speed);
		} else {
			await this.start();
		}
	}

	/** Builds and runs the selected scope (the command and the smoke test call it). */
	async start(scope = this.scopeSelect.value, speed = this.speed): Promise<SimState> {
		if (this.scopes.length === 0) {
			await this.load();
		}
		if (scope && this.scopeSelect.value !== scope) {
			this.scopeSelect.value = scope;
		}
		this.serialText = '';
		this.serialOut.textContent = '';
		this.series.clear();
		const state = await this.sim.prepare(this.scopeSelect.value || 'Whole device');
		if (state.kind === 'ready') {
			await this.sim.run(speed);
		}
		return this.sim.state;
	}

	private async step(): Promise<void> {
		if (this.sim.state.kind === 'idle' || this.sim.state.kind === 'error') {
			const state = await this.sim.prepare(this.scopeSelect.value || 'Whole device');
			if (state.kind !== 'ready') {
				return;
			}
		}
		await this.sim.step(0.01);
	}

	private showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.status.textContent = message;
		this.element.dataset['error'] = message;
		this.logService.warn('[triage] Sim tab', error);
	}

	private onState(state: SimState): void {
		this.element.dataset['state'] = state.kind;
		this.runButton.textContent = state.kind === 'running' ? localize('triage.sim.pause', "Pause") : localize('triage.sim.run', "Run");
		if (state.kind === 'error') {
			this.status.textContent = state.message;
			this.element.dataset['error'] = state.message;
		} else if (state.kind === 'building') {
			this.status.textContent = localize('triage.sim.building', "Building the {0}…", state.what);
		} else if (state.kind === 'idle') {
			this.status.textContent = localize('triage.sim.idle', "Pick a scope and press Run.");
		}
		const info = 'info' in state ? state.info : undefined;
		if (info !== this.info) {
			this.info = info;
			this.renderControls(info);
		}
	}

	// ---- Controls ------------------------------------------------------------------------

	private section(title: string): HTMLElement {
		const section = append(this.controls, $('.triage-sim-section'));
		append(section, $('h3', undefined, title));
		return section;
	}

	private slider(parent: HTMLElement, label: string, control: string, min: number, max: number, value: number, unit: string, scale = 1): void {
		const row = append(parent, $('.triage-sim-row'));
		append(row, $('span.triage-sim-name', undefined, label));
		const input = append(row, $('input')) as HTMLInputElement;
		input.type = 'range';
		input.min = String(min);
		input.max = String(max);
		input.step = String((max - min) / 200);
		input.value = String(value);
		input.dataset['control'] = control;
		const readout = append(row, $('span.triage-sim-value', undefined, `${value.toFixed(2)} ${unit}`));
		this.panelDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
			const v = Number(input.value);
			readout.textContent = `${v.toFixed(2)} ${unit}`;
			void this.sim.input(control, v * scale);
		}));
	}

	private momentary(parent: HTMLElement, label: string, control: string, pressed: number, released: number): void {
		const row = append(parent, $('.triage-sim-row'));
		append(row, $('span.triage-sim-name', undefined, label));
		const button = append(row, $('button.triage-sim-button.momentary')) as HTMLButtonElement;
		button.textContent = localize('triage.sim.press', "Press");
		button.dataset['control'] = control;
		const set = (down: boolean) => {
			button.classList.toggle('down', down);
			// A click is held for at least MIN_PRESS_SECONDS of simulated time (release).
			void (down ? this.sim.input(control, pressed) : this.sim.release(control, released));
		};
		this.panelDisposables.add(addDisposableListener(button, EventType.POINTER_DOWN, () => set(true)));
		this.panelDisposables.add(addDisposableListener(button, EventType.POINTER_UP, () => set(false)));
		this.panelDisposables.add(addDisposableListener(button, EventType.POINTER_LEAVE, () => button.classList.contains('down') && set(false)));
	}

	private renderControls(info: ISimRunInfo | undefined): void {
		this.panelDisposables.clear();
		this.indicators.clear();
		reset(this.controls);
		if (!info) {
			append(this.controls, $('p.triage-sim-hint', undefined, localize('triage.sim.hint', "Run the whole device, or just the circuit, the code or the mechanism: the parts a scope leaves out are replaced by stubs you control here.")));
			return;
		}
		const summary = this.section(localize('triage.sim.run.summary', "This run"));
		const runs = info.units.filter(u => u[1] !== 'stub').map(u => u[0]);
		append(summary, $('p', undefined, localize('triage.sim.runsUnits', "Runs: {0}", runs.join(', '))));
		if (info.leftOut.length > 0) {
			append(summary, $('p', undefined, localize('triage.sim.leftOut', "Left out: {0}", info.leftOut.join(', '))));
		}
		append(summary, $('p', undefined, localize('triage.sim.mechanics', "Mechanics: {0}", info.mechanicsEngine === 'mujoco' ? 'MuJoCo' : info.mechanicsEngine)));
		if (info.firmware) {
			append(summary, $('p', undefined, localize('triage.sim.firmware', "Firmware: {0}", info.firmware)));
		}

		if (info.controls.includes('env.room_temperature_c')) {
			const env = this.section(localize('triage.sim.environment', "Environment"));
			this.slider(env, localize('triage.sim.room', "Room temperature"), 'env.room_temperature_c', 10, 45, 24, '°C');
		}
		const parts = info.controls.filter(c => /\.(pressed|position)$/.test(c));
		if (parts.length > 0) {
			const section = this.section(localize('triage.sim.parts', "Parts"));
			for (const control of parts) {
				const ref = control.split('.')[0];
				if (control.endsWith('.pressed')) {
					this.momentary(section, ref, control, 1, 0);
				} else {
					this.slider(section, ref, control, 0, 1, 0.5, '');
				}
			}
		}
		if (info.ioPanel.length > 0) {
			const io = this.section(localize('triage.sim.virtualIo', "Virtual I/O (stands in for the circuit)"));
			for (const element of info.ioPanel) {
				if (element.kind === 'button' && element.control) {
					this.momentary(io, element.label, element.control, element.pressed, element.value);
				} else if (element.kind === 'slider' && element.control) {
					this.slider(io, element.label, element.control, element.min, element.max, element.value, 'V');
				} else if (element.signal) {
					const row = append(io, $('.triage-sim-row'));
					append(row, $('span.triage-sim-name', undefined, element.label));
					const led = append(row, $('span.triage-sim-led'));
					led.dataset['signal'] = element.signal;
					this.indicators.set(element.signal, led);
				}
			}
		}
		const controlStubs = info.stubs.filter(s => s.kind !== 'hold' && s.kind !== 'open');
		if (info.stubs.length > 0) {
			const stubs = this.section(localize('triage.sim.stubs', "Stubs at the scope's edge"));
			for (const stub of info.stubs) {
				append(stubs, $('p.triage-sim-stub', undefined, `${stub.signal}: ${stub.kind}`));
			}
			for (const stub of controlStubs) {
				const duty = `${stub.signal}.duty`;
				if (info.controls.includes(duty)) {
					this.slider(stubs, localize('triage.sim.pwmDuty', "{0} PWM duty", stub.signal), duty, 0, 1, 0.5, '');
				} else if (stub.signal.endsWith('.torque') && info.controls.includes(`${stub.signal}.value`)) {
					this.slider(stubs, localize('triage.sim.torque', "{0} (mN·m)", stub.signal), `${stub.signal}.value`, 0, 5, 0, 'mN·m', 1e-3);
				}
			}
		}
		this.oledBox.style.display = info.displays.length > 0 ? '' : 'none';
		for (const [i, plotted] of info.plotted.entries()) {
			this.series.set(plotted.signal, { label: plotted.label, unit: plotted.unit, colour: COLOURS[i % COLOURS.length], t: [], v: [] });
		}
	}

	// ---- Frames ---------------------------------------------------------------------------

	private onFrame(frame: ISimFrame): void {
		this.element.dataset['t'] = frame.t.toFixed(4);
		this.element.dataset['ratio'] = frame.ratio.toFixed(3);
		const info = this.info;
		this.status.textContent = localize('triage.sim.time', "t = {0} s · {1}× real time{2}", frame.t.toFixed(3), frame.ratio.toFixed(2), info ? ` · ${info.scope}` : '');
		for (const [signal, points] of Object.entries(frame.plots)) {
			const series = this.series.get(signal);
			if (!series) {
				continue;
			}
			for (let i = 0; i < points.length; i += 2) {
				series.t.push(points[i]);
				series.v.push(points[i + 1]);
			}
			const cut = series.t.findIndex(t => t >= frame.t - PLOT_SECONDS);
			if (cut > 0) {
				series.t.splice(0, cut);
				series.v.splice(0, cut);
			}
		}
		for (const [signal, indicator] of this.indicators) {
			const duty = frame.duty[signal];
			const level = frame.values[signal];
			const on = duty !== undefined ? duty : level === 1 ? 1 : 0;
			indicator.style.opacity = String(0.15 + 0.85 * on);
			indicator.textContent = duty !== undefined ? `${Math.round(duty * 100)}%` : level === 1 ? 'H' : level === 0 ? 'L' : '–';
			// Each change of level counts (a smoke check watches Blink blink).
			if (indicator.dataset['level'] !== indicator.textContent) {
				indicator.dataset['changes'] = String(Number(indicator.dataset['changes'] ?? 0) + 1);
				indicator.dataset['level'] = indicator.textContent;
			}
		}
		if (frame.serial) {
			this.serialText = (this.serialText + frame.serial).slice(-20_000);
			this.serialOut.textContent = this.serialText;
			this.serialOut.scrollTop = this.serialOut.scrollHeight;
		}
		for (const [ref, display] of Object.entries(frame.displays)) {
			this.drawOled(display.buffer, display.on);
			this.oledBox.dataset['ref'] = ref;
			this.oledBox.dataset['text'] = display.text;
		}
		this.schedulePlot();
	}

	private drawOled(buffer: readonly number[], on: boolean): void {
		const context = this.oledCanvas.getContext('2d');
		if (!context) {
			return;
		}
		const image = context.createImageData(128, 64);
		for (let y = 0; y < 64; y++) {
			for (let x = 0; x < 128; x++) {
				const lit = on && ((buffer[(y >> 3) * 128 + x] ?? 0) & (1 << (y & 7))) !== 0;
				const i = (y * 128 + x) * 4;
				image.data[i] = lit ? 140 : 8;
				image.data[i + 1] = lit ? 220 : 10;
				image.data[i + 2] = lit ? 255 : 18;
				image.data[i + 3] = 255;
			}
		}
		context.putImageData(image, 0, 0);
	}

	private schedulePlot(): void {
		if (this.plotRequested) {
			return;
		}
		this.plotRequested = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.plotRequested = false;
			this.drawPlot();
		});
	}

	private drawPlot(): void {
		const canvas = this.plotCanvas;
		const dpr = getWindow(canvas).devicePixelRatio || 1;
		const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
		const context = canvas.getContext('2d');
		if (!context) {
			return;
		}
		context.clearRect(0, 0, width, height);
		context.strokeStyle = 'rgba(128,128,128,0.25)';
		context.lineWidth = 1;
		for (let i = 1; i < 4; i++) {
			context.beginPath();
			context.moveTo(0, (height * i) / 4);
			context.lineTo(width, (height * i) / 4);
			context.stroke();
		}
		let end = 0;
		for (const s of this.series.values()) {
			end = Math.max(end, s.t[s.t.length - 1] ?? 0);
		}
		const start = Math.max(0, end - PLOT_SECONDS);
		reset(this.legend);
		for (const s of this.series.values()) {
			if (s.t.length === 0) {
				continue;
			}
			// Each signal on its own scale, so currents and temperatures share the plot.
			let lo = Math.min(...s.v);
			let hi = Math.max(...s.v);
			if (hi - lo < 1e-9) {
				hi += 0.5;
				lo -= 0.5;
			}
			context.strokeStyle = s.colour;
			context.lineWidth = 1.5 * dpr;
			context.beginPath();
			for (let i = 0; i < s.t.length; i++) {
				const x = ((s.t[i] - start) / PLOT_SECONDS) * width;
				const y = height - 4 - ((s.v[i] - lo) / (hi - lo)) * (height - 8);
				if (i === 0) {
					context.moveTo(x, y);
				} else {
					context.lineTo(x, y);
				}
			}
			context.stroke();
			const last = s.v[s.v.length - 1];
			const entry = append(this.legend, $('span.triage-sim-legend-entry'));
			entry.style.color = s.colour;
			entry.textContent = `${s.label}: ${Number(last.toPrecision(4))} ${s.unit}`;
		}
	}

	// ---- Scenarios -----------------------------------------------------------------------

	private renderScenarios(results: readonly ISimScenarioResult[]): void {
		reset(this.scenarioList);
		if (this.scenarios.length === 0) {
			append(this.scenarioList, $('p.triage-sim-hint', undefined, localize('triage.sim.noScenarios', "No scenarios in simulation/scenarios/.")));
			return;
		}
		const all = this.button(this.scenarioList, localize('triage.sim.runAll', "Run all scenarios"), () => this.runScenarios(this.scenarios), 'scenarios');
		all.classList.add('primary');
		for (const file of this.scenarios) {
			const row = append(this.scenarioList, $('.triage-sim-scenario'));
			const result = results.find(r => r.file === file);
			row.dataset['file'] = basename(file);
			row.dataset['result'] = result ? (result.passed ? 'passed' : 'failed') : 'none';
			append(row, $('span.triage-sim-mark', undefined, result ? (result.passed ? '✓' : '✗') : '·'));
			append(row, $('span.triage-sim-name', undefined, result?.name ?? basename(file)));
			this.button(row, localize('triage.sim.runOne', "Run"), () => this.runScenarios([file]), 'scenario');
			if (result) {
				const details = append(row, $('ul'));
				if (result.error) {
					append(details, $('li.failed', undefined, result.error));
				}
				for (const check of result.checks) {
					append(details, $(`li.${check.passed ? 'passed' : 'failed'}`, undefined, `${check.kind}: ${check.that} — ${check.detail}`));
				}
			}
		}
	}

	private scenarioResults: ISimScenarioResult[] = [];

	/** Runs scenario files headless and shows their results (the Test Explorer uses the same). */
	async runScenarios(files: readonly string[]): Promise<ISimScenarioResult[]> {
		this.element.dataset['scenarios'] = 'running';
		const results = await this.sim.runScenarios(files);
		this.scenarioResults = [...this.scenarioResults.filter(r => !files.includes(r.file)), ...results];
		this.renderScenarios(this.scenarioResults);
		this.element.dataset['scenarios'] = results.every(r => r.passed) ? 'passed' : 'failed';
		return results;
	}

	layout(width: number, height: number): void {
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		this.schedulePlot();
	}
}
