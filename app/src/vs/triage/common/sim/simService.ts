/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The simulation (ROADMAP P3, PLAN §4.7): the sim engine runs in a utility process
 *  (node/simEngineMain.ts) with Triage's kernel (crates/triage-sim-node, Rust) and
 *  the AVR unit (sim/, avr8js); the window's ITriageSimService drives it and
 *  passes its frames (state at up to 30 Hz) to the Sim tab and the 3D tab.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

export const SIM_ENGINE_CHANNEL = 'triageSimEngine';
export const SIM_ENGINE_MODULE = 'vs/triage/node/simEngineMain';
export const SIM_ENGINE_STATUS_ID = 'triage.simEngine';
/** Where the packaged app keeps the simulation (app/build.mjs engines): dist/, node_modules/, triage_sim.node. */
export const SIM_ENGINE_FOLDER = 'sim';

export type { ISimFrame, ISimIoElement, ISimRunInfo, ISimScenarioResult, ISimScope, SimState } from './simTypes.js';
import type { ISimFrame, ISimIoElement, ISimScenarioResult, ISimScope, SimState } from './simTypes.js';

/** The sim engine's side of the MessagePort channel (utility process). */
export interface ISimEngine {
	readonly onDidFrame: Event<ISimFrame>;
	readonly onDidChangeState: Event<SimState>;
	/** `folder`: the packaged simulation (SIM_ENGINE_FOLDER). */
	load(folder: string, project: string): Promise<{ scopes: ISimScope[]; scenarios: string[]; mujoco: boolean }>;
	/** Builds the firmware (when the scope runs it) and the device; doesn't run yet. */
	prepare(scope: string): Promise<SimState>;
	run(speed: number): Promise<void>;
	pause(): Promise<void>;
	/** Advances `seconds` of virtual time and pauses. */
	step(seconds: number): Promise<void>;
	stop(): Promise<void>;
	setSpeed(speed: number): Promise<void>;
	input(control: string, value: number): Promise<void>;
	/**
	 * Lets go of a momentary control (a button): sets `value`, but no sooner than
	 * MIN_PRESS_SECONDS of simulated time after the control's last input, so a click
	 * reaches debouncing firmware however slowly the simulation runs.
	 */
	release(control: string, value: number): Promise<void>;
	sendSerial(text: string): Promise<void>;
	/** Runs scenario files headless (the Test Explorer and the CLI's runner). */
	runScenarios(files: readonly string[]): Promise<ISimScenarioResult[]>;
	getState(): Promise<SimState>;
}

export const ITriageSimService = createDecorator<ITriageSimService>('triageSimService');

/** The window's simulation: one run at a time, shared by the Sim and 3D tabs. */
export interface ITriageSimService {
	readonly _serviceBrand: undefined;
	readonly state: SimState;
	readonly onDidChangeState: Event<SimState>;
	readonly onDidFrame: Event<ISimFrame>;
	/** The last frame (a tab opened mid-run draws it at once). */
	readonly lastFrame: ISimFrame | undefined;
	/** Scopes and scenarios of the open project (loads the engine). */
	load(): Promise<{ scopes: readonly ISimScope[]; scenarios: readonly string[]; mujoco: boolean }>;
	prepare(scope: string): Promise<SimState>;
	run(speed?: number): Promise<void>;
	pause(): Promise<void>;
	step(seconds: number): Promise<void>;
	stop(): Promise<void>;
	setSpeed(speed: number): Promise<void>;
	input(control: string, value: number): Promise<void>;
	release(control: string, value: number): Promise<void>;
	sendSerial(text: string): Promise<void>;
	runScenarios(files: readonly string[]): Promise<ISimScenarioResult[]>;
}

/** The subset of @triage/sim the engine uses (sim/src/index.ts), loaded at run time. */
export interface ISimModule {
	loadProject(root: string): ISimProject;
	deviceSpec(project: ISimProject, environment?: unknown): unknown;
	scopes(project?: ISimProject): ISimScope[];
	findScope(name: string, project?: ISimProject): ISimScope & { stubs: unknown };
	buildProjectFirmware(project: ISimProject): { hex: string; flash: number; ram: number; cached: boolean; toolchain: string };
	loadScenario(file: string): { name: string; file: string; scope: string; duration: number };
	runScenario(project: ISimProject, scenario: unknown, firmwareHex?: string): {
		passed: boolean; wall: number; speed: number; error?: string;
		scenario: { name: string; file: string; scope: string };
		checks: { check: { kind: string; that: string }; passed: boolean; detail: string }[];
	};
	loadAddon(file?: string): { version(): string };
	Runner: new (options: { device: unknown; scope: unknown; firmwareHex?: string }) => ISimRunner;
}

export interface ISimProject {
	readonly root: string;
	readonly simulationDir: string;
}

export interface ISimRunner {
	readonly info: {
		scope: string; units: [string, string, string][]; stubs: { signal: string; kind: string }[]; left_out: string[];
		controls: string[]; io_panel: ISimIoElement[]; signals: [string, string][];
		bodies: { name: string; object: string | null; axis: number[]; origin: number[]; angle: string; omega: string }[];
		leds: [string, string][]; mechanics_engine: string;
	};
	readonly displays: Map<string, { readonly buffer: Uint8Array; readonly text: string; readonly on: boolean; readonly version: number }>;
	readonly avr: { serial: { t: number; byte: number }[]; sendSerial(bytes: Iterable<number>): void } | undefined;
	readonly now: number;
	readonly sim: { trimTraces(t: number): void; values(ids: Uint32Array): Float64Array };
	runUntil(seconds: number): void;
	input(control: string, value: number): void;
	value(signal: string): number;
	trace(signal: string, fromSeconds?: number): { t: Float64Array; v: Float64Array };
	driveFor(net: string): string | undefined;
}
