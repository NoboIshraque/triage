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

/** The model service's side of the MessagePort channel (utility process). */
export interface IProjectModelChannel {
	/** Loads `<folder>/triage.toml`; null when the folder is not a Triage project. */
	loadProject(addonPath: string, folder: string): Promise<ITriageProject | null>;
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
}
