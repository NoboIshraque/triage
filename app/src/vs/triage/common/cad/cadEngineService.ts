/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The CAD engine (ROADMAP P2-2, P2-3): FreeCAD's App layer as a hidden process
 *  behind the 3D tab (ADR 0002). Renderer -> MessagePort -> broker (utility process)
 *  -> local socket -> FreeCADCmd running Triage's engine host, as for the EDA engine.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { EngineState } from '../engineProtocol.js';
import { CadMesh } from './cadEngine.js';

export const CAD_ENGINE_CHANNEL = 'triageCadEngine';
export const CAD_ENGINE_BROKER_MODULE = 'vs/triage/node/cadEngineBrokerMain';
export const CAD_ENGINE_STATUS_ID = 'triage.cadEngine';
/** Where the packaged app keeps the engine (engines/cad/build.mjs stage, app/build.mjs engines). */
export const CAD_ENGINE_FOLDER = 'cad';

/** The broker's side of the MessagePort channel (runs in the utility process). */
export interface ICadEngineBroker {
	readonly onDidChangeState: Event<EngineState>;
	/**
	 * `folder` holds the staged engine (bin/FreeCADCmd, triage/triage_cad_engine.py);
	 * `userHome` is where FreeCAD keeps its settings for Triage, apart from a FreeCAD
	 * the user may have installed.
	 */
	start(folder: string, userHome: string): Promise<EngineState>;
	getState(): Promise<EngineState>;
	/**
	 * Sends one JSON-RPC request (UTF-8, with a unique id) and waits for its
	 * response; the reply is packed like the EDA engine's (packReply): the
	 * response first, then the mesh frames it streamed.
	 */
	request(request: VSBuffer): Promise<VSBuffer>;
	kill(): Promise<void>;
}

export class CadEngineError extends Error {
	constructor(message: string, readonly code?: number) {
		super(message);
	}
}

/** One answered call: its result and the meshes streamed before it. */
export interface ICadResult<T> {
	readonly result: T;
	readonly meshes: readonly CadMesh[];
}

export const ITriageCadEngineService = createDecorator<ITriageCadEngineService>('triageCadEngineService');

export interface ITriageCadEngineService {
	readonly _serviceBrand: undefined;
	readonly state: EngineState;
	readonly onDidChangeState: Event<EngineState>;
	/** Fires after the engine restarted: its documents are gone and must be reopened. */
	readonly onDidRestart: Event<void>;
	/** Calls one JSON-RPC method; rejects with CadEngineError on a JSON-RPC error. */
	call<T>(method: string, params?: unknown): Promise<ICadResult<T>>;
	kill(): Promise<void>;
}
