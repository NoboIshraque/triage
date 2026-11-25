/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The EDA engine (ROADMAP P1-2): KiCad's engine as a hidden process behind the
 *  Schematic and Board tabs (ADR 0002). Renderer -> MessagePort -> broker (utility
 *  process) -> local socket -> triage-eda-engine, as for the hello engine (P0-4).
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { EngineState } from '../engineProtocol.js';
import { Message } from './protobuf.js';

export const EDA_ENGINE_CHANNEL = 'triageEdaEngine';
export const EDA_ENGINE_BROKER_MODULE = 'vs/triage/node/edaEngineBrokerMain';
export const EDA_ENGINE_STATUS_ID = 'triage.edaEngine';
/** Where the packaged app keeps the engine (engines/eda/build.mjs stage, app/build.mjs engines). */
export const EDA_ENGINE_FOLDER = 'eda';

/** Frame types of the EDA engine connection (engines/eda/triage/engine/host.cpp). */
export const EdaFrame = {
	Request: 0x20,
	Response: 0x21,
	DisplayList: 0x22,
} as const;

/** One answered request: the response and the display-list chunks sent before it. */
export interface IEdaReply {
	readonly response: VSBuffer;
	readonly chunks: readonly VSBuffer[];
}

/** The broker's side of the MessagePort channel (runs in the utility process). */
export interface IEdaEngineBroker {
	readonly onDidChangeState: Event<EngineState>;
	/** `folder` holds triage-eda-engine with its kifaces and libraries. */
	start(folder: string): Promise<EngineState>;
	getState(): Promise<EngineState>;
	/** Sends one triage.eda.v1.Request (with a unique id) and waits for its Response. */
	request(request: VSBuffer): Promise<IEdaReply>;
	/** Opens `path` in KiCad's own editor window (the temporary fallback, ROADMAP P1-7). */
	openInKicad(path: string): Promise<void>;
	kill(): Promise<void>;
}

/** A decoded reply. */
export interface IEdaResult {
	readonly response: Message;
	readonly chunks: readonly Uint8Array[];
}

export class EdaEngineError extends Error { }

export const ITriageEdaEngineService = createDecorator<ITriageEdaEngineService>('triageEdaEngineService');

/** The window's view of the EDA engine. Starts it lazily, on the first request. */
export interface ITriageEdaEngineService {
	readonly _serviceBrand: undefined;
	readonly state: EngineState;
	readonly onDidChangeState: Event<EngineState>;
	/** Fires when the engine restarted: documents must be opened again. */
	readonly onDidRestart: Event<void>;
	/** Fires after an edit, undo, redo, reload or save changed an open document. */
	readonly onDidChangeDocument: Event<{ readonly document: number; readonly path: string }>;
	/** An open document of this window's engine for `path` (the latest opened), if any. */
	documentFor(path: string): number | undefined;
	/**
	 * Sends a request: `command` is the Request field (e.g. 'openDocument') and
	 * `body` its message. Rejects with EdaEngineError when the engine says no.
	 */
	call(command: string, body: Message): Promise<IEdaResult>;
	/** Opens `path` in KiCad's own editor window (the temporary fallback, ROADMAP P1-7). */
	openInKicad(path: string): Promise<void>;
	kill(): Promise<void>;
}
