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
	readonly response: Uint8Array;
	readonly chunks: readonly Uint8Array[];
}

/**
 * VS Code's IPC carries a VSBuffer intact only as a whole argument or result;
 * nested in an object it would become JSON. So a reply travels as one buffer:
 * u32 count of parts, then per part u32 length and bytes (response first).
 */
export function packReply(reply: IEdaReply): VSBuffer {
	const parts = [reply.response, ...reply.chunks];
	const size = 4 + parts.reduce((total, part) => total + 4 + part.byteLength, 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	view.setUint32(0, parts.length, true);
	let offset = 4;
	for (const part of parts) {
		view.setUint32(offset, part.byteLength, true);
		out.set(part, offset + 4);
		offset += 4 + part.byteLength;
	}
	return VSBuffer.wrap(out);
}

export function unpackReply(packed: Uint8Array): IEdaReply {
	const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
	const count = view.getUint32(0, true);
	const parts: Uint8Array[] = [];
	let offset = 4;
	for (let i = 0; i < count; i++) {
		const length = view.getUint32(offset, true);
		// A copy per part: display-list chunks are viewed as Float32Arrays, which need
		// 4-byte alignment and their own buffer.
		parts.push(packed.slice(offset + 4, offset + 4 + length));
		offset += 4 + length;
	}
	return { response: parts[0], chunks: parts.slice(1) };
}

/** The broker's side of the MessagePort channel (runs in the utility process). */
export interface IEdaEngineBroker {
	readonly onDidChangeState: Event<EngineState>;
	/** `folder` holds triage-eda-engine with its kifaces and libraries. */
	start(folder: string): Promise<EngineState>;
	getState(): Promise<EngineState>;
	/** Sends one triage.eda.v1.Request (with a unique id) and waits for its Response (packReply). */
	request(request: VSBuffer): Promise<VSBuffer>;
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
