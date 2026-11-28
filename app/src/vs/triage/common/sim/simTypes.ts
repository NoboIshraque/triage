/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  What a simulation run is and sends (ROADMAP P3): scopes, the run's parts and
 *  controls, frames, states and scenario results. No VS Code imports (PLAN §4.16):
 *  the phone app reads the same frames.
 *--------------------------------------------------------------------------------------------*/

/** A scope the picker offers (built-in or simulation/scopes/*.toml). */
export interface ISimScope {
	readonly name: string;
	readonly id?: string;
	readonly run: readonly string[];
}

/** An element of the virtual I/O panel (code-only runs). */
export interface ISimIoElement {
	readonly kind: 'button' | 'slider' | 'indicator';
	readonly label: string;
	readonly control: string | null;
	readonly signal: string | null;
	readonly min: number;
	readonly max: number;
	readonly value: number;
	readonly pressed: number;
}

/** What a run is made of, once it started. */
export interface ISimRunInfo {
	readonly scope: string;
	readonly units: readonly (readonly [string, string, string])[];
	readonly stubs: readonly { readonly signal: string; readonly kind: string }[];
	readonly leftOut: readonly string[];
	readonly controls: readonly string[];
	readonly ioPanel: readonly ISimIoElement[];
	readonly bodies: readonly { readonly name: string; readonly object: string | null; readonly axis: readonly number[]; readonly origin: readonly number[]; readonly angle: string; readonly omega: string }[];
	readonly leds: readonly (readonly [string, string])[];
	readonly displays: readonly string[];
	readonly mechanicsEngine: string;
	readonly firmware?: string;
	/** Instruments: the signals plotted. */
	readonly plotted: readonly { readonly signal: string; readonly label: string; readonly unit: string }[];
}

/** One frame of a running simulation (PLAN §4.7: published at 60 Hz or less). */
export interface ISimFrame {
	/** Virtual time, s. */
	readonly t: number;
	/** Simulated seconds per wall second over the last frames. */
	readonly ratio: number;
	readonly running: boolean;
	/** Current values of the run's signals (logic levels as numbers: 0 low, 1 high, 2 Z, 4 pulled up). */
	readonly values: Readonly<Record<string, number>>;
	/** Points since the last frame for each plotted signal: [t, v, t, v …]. */
	readonly plots: Readonly<Record<string, readonly number[]>>;
	/** Serial output since the last frame. */
	readonly serial: string;
	/** Displays whose picture changed: reference → 1024 bytes (SSD1306 pages) and its text. */
	readonly displays: Readonly<Record<string, { readonly buffer: readonly number[]; readonly text: string; readonly on: boolean }>>;
	/** PWM duty of each board pin over the last 20 ms. */
	readonly duty: Readonly<Record<string, number>>;
}

export type SimState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'building'; readonly what: string }
	| { readonly kind: 'ready'; readonly info: ISimRunInfo }
	| { readonly kind: 'running'; readonly info: ISimRunInfo }
	| { readonly kind: 'paused'; readonly info: ISimRunInfo }
	| { readonly kind: 'error'; readonly message: string };

/** A scenario's result (sim/src/scenario.ts). */
export interface ISimScenarioResult {
	readonly name: string;
	readonly file: string;
	readonly scope: string;
	readonly passed: boolean;
	readonly wall: number;
	readonly speed: number;
	readonly error?: string;
	readonly checks: readonly { readonly kind: string; readonly that: string; readonly passed: boolean; readonly detail: string }[];
}
