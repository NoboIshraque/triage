/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The project model as the window sees it (ROADMAP P0-5): triage.toml read by the
 *  Rust model (crates/triage-model) through its napi addon in a utility process.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';

export const PROJECT_MODEL_CHANNEL = 'triageProjectModel';
export const PROJECT_MODEL_MODULE = 'vs/triage/node/projectModelMain';
export const PROJECT_MODEL_ADDON = 'triage_model.node';

/** Mirrors JsProject in crates/triage-model-node/src/lib.rs. */
export interface ITriageProject {
	readonly root: string;
	readonly name: string;
	readonly description?: string;
	readonly format: number;
	readonly domains: readonly ITriageDomain[];
	/** firmware.board, the board profile id (arduino-uno). */
	readonly board?: string;
	/** firmware.fqbn, the board for builds and uploads (arduino:avr:uno). */
	readonly fqbn?: string;
	/** firmware.libraries, Name@version. */
	readonly libraries?: readonly string[];
}

export interface ITriageDomain {
	readonly id: 'code' | 'electronics' | 'mechanical' | 'simulation';
	readonly label: string;
	readonly configured: boolean;
	readonly path: string;
	readonly exists: boolean;
	readonly files: readonly { readonly path: string; readonly exists: boolean }[];
	readonly detail?: string;
}

/** A schematic component as the pin map needs it (from the EDA engine's netlist). */
export interface IPinMapComponent {
	readonly reference: string;
	readonly libId: string;
	readonly footprint: string;
	readonly pins: readonly { readonly number: string; readonly name: string; readonly net: string }[];
}

/** One board pin and its net (crates/triage-model/src/pinmap.rs). */
export interface IPinAssignment {
	readonly pin: string;
	readonly number: number;
	readonly net: string;
	readonly constant?: string;
	readonly connected: boolean;
	readonly pwm: boolean;
	readonly analog: boolean;
	readonly digital: boolean;
	readonly role?: string;
}

export interface IPinDiagnostic {
	readonly path: string;
	readonly severity: 'error' | 'warning';
	readonly line: number;
	readonly column: number;
	readonly endColumn: number;
	readonly message: string;
}

/** The pin map of a project (ROADMAP P1-5). */
export interface IPinMap {
	readonly board: string;
	readonly boardName: string;
	readonly fqbn: string;
	readonly platformio: string;
	readonly reference: string;
	/** The text of board_pins.h. */
	readonly header: string;
	readonly pins: readonly IPinAssignment[];
	readonly diagnostics: readonly IPinDiagnostic[];
}

/** The model service's side of the MessagePort channel (utility process). */
export interface IProjectModelChannel {
	/** Loads `<folder>/triage.toml`; null when the folder is not a Triage project. */
	loadProject(addonPath: string, folder: string): Promise<ITriageProject | null>;
	/** Maps the schematic's nets to the board's pins and checks the firmware sources. */
	pinMap(addonPath: string, board: string, schematic: string, components: readonly IPinMapComponent[], sources: readonly { path: string; text: string }[]): Promise<IPinMap>;
}

export type TriageProjectState =
	| { readonly kind: 'none' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'project'; readonly project: ITriageProject }
	| { readonly kind: 'error'; readonly message: string };

export const ITriageProjectService = createDecorator<ITriageProjectService>('triageProjectService');

/** The Triage project of the first workspace folder, if it has a triage.toml. */
export interface ITriageProjectService {
	readonly _serviceBrand: undefined;
	readonly state: TriageProjectState;
	readonly onDidChangeState: Event<TriageProjectState>;
	refresh(): Promise<void>;
	/** Runs the pin map in the model service (see IProjectModelChannel.pinMap). */
	pinMap(board: string, schematic: string, components: readonly IPinMapComponent[], sources: readonly { path: string; text: string }[]): Promise<IPinMap>;
}
