/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The companion protocol inside the Noise session (ROADMAP PC-2 to PC-6, PLAN
 *  §4.16): protobuf envelopes, triage.companion.v1, with the same codec as the EDA
 *  engine's messages (eda/protobuf.ts).
 *
 *    message Envelope {
 *      uint32 id = 1;           // a request's number (phone → laptop); 0 for events
 *      uint32 reply_to = 2;     // the request a reply answers
 *      string kind = 3;         // "hello", "eda", "sim.run", "event:document" …
 *      string json = 4;         // the body, JSON
 *      repeated bytes blobs = 5;// binary parts: triage.eda.v1 requests and responses,
 *                               // display-list chunks (TDL1), meshes
 *      string error = 6;        // a refused or failed request
 *    }
 *
 *  EDA requests travel as triage.eda.v1 Request bytes in blobs[0]; the CAD and
 *  simulation engines speak JSON already, so their bodies stay JSON (DV-43).
 *  What a phone may ask is decided here (requiredPermission), and the laptop
 *  checks every request against it. No VS Code imports: the phone app bundles this.
 *--------------------------------------------------------------------------------------------*/

import { decodeMessage, encodeMessage, Message, MessageDescriptor } from '../eda/protobuf.js';

/** The companion protocol's version; the laptop refuses phone apps outside its range. */
export const COMPANION_PROTOCOL = 1;
export const COMPANION_PROTOCOL_MIN = 1;
export const COMPANION_PROTOCOL_MAX = 1;

export const Envelope: MessageDescriptor = {
	name: 'Envelope',
	fields: [
		{ name: 'id', number: 1, type: 'uint32' },
		{ name: 'replyTo', number: 2, type: 'uint32' },
		{ name: 'kind', number: 3, type: 'string' },
		{ name: 'json', number: 4, type: 'string' },
		{ name: 'blobs', number: 5, type: 'bytes', repeated: true },
		{ name: 'error', number: 6, type: 'string' },
	],
};

export interface CompanionEnvelope {
	readonly id: number;
	readonly replyTo: number;
	readonly kind: string;
	readonly json: string;
	readonly blobs: readonly Uint8Array[];
	readonly error: string;
}

export function encodeEnvelope(envelope: Partial<CompanionEnvelope> & { kind: string }): Uint8Array {
	return encodeMessage(Envelope, {
		id: envelope.id ?? 0,
		replyTo: envelope.replyTo ?? 0,
		kind: envelope.kind,
		json: envelope.json ?? '',
		blobs: envelope.blobs ?? [],
		error: envelope.error ?? '',
	} as Message);
}

/** Decodes an envelope; throws on bytes that aren't one (a phone's are untrusted). */
export function decodeEnvelope(bytes: Uint8Array): CompanionEnvelope {
	const m = decodeMessage(Envelope, bytes) as { id?: unknown; replyTo?: unknown; kind?: unknown; json?: unknown; blobs?: unknown; error?: unknown };
	if (typeof m.kind !== 'string' || m.kind.length === 0 || m.kind.length > 64) {
		throw new Error('an envelope needs a kind');
	}
	return {
		id: Number(m.id ?? 0),
		replyTo: Number(m.replyTo ?? 0),
		kind: m.kind,
		json: typeof m.json === 'string' ? m.json : '',
		blobs: Array.isArray(m.blobs) ? m.blobs as Uint8Array[] : [],
		error: typeof m.error === 'string' ? m.error : '',
	};
}

export type CompanionPermission = 'view' | 'edit';

/** The phone's first message. */
export interface CompanionHello {
	readonly app: string;
	readonly version: string;
	readonly protocol: number;
	readonly name: string;
	readonly platform?: string;
	/** A typed-code pairing: the phone's static public key, base64url (Noise NNpsk0 carries none). */
	readonly phoneKey?: string;
}

/** The laptop's answer once the person allowed the phone in. */
export interface CompanionWelcome {
	readonly permission: CompanionPermission;
	readonly laptop: string;
	readonly project: string;
	readonly views: readonly CompanionViewInfo[];
	/** The tab to open first. */
	readonly view: string;
	/** The phone's mailbox (its id when reconnecting), base64url. */
	readonly mailbox: string;
	/** The laptop's static key, base64url. */
	readonly laptopKey: string;
	/** Certificate hashes to pin: the served one and the next (base64url). */
	readonly certificateHashes: readonly string[];
	readonly addresses: readonly string[];
	readonly relay?: string;
	readonly protocol: number;
	readonly triageVersion: string;
}

export interface CompanionViewInfo {
	readonly id: 'board' | 'schematic' | '3d' | 'sim';
	readonly label: string;
	readonly available: boolean;
	readonly detail?: string;
}

/** EDA commands a phone may send with view permission. */
export const EDA_VIEW_COMMANDS: readonly string[] = ['getVersion', 'getDisplayList', 'hitTest', 'getItems', 'getNetlist'];
/** EDA commands that need edit permission (PLAN §4.16: P1-6's simple edits). */
export const EDA_EDIT_COMMANDS: readonly string[] = ['edit', 'undo', 'redo', 'save'];
/** The edit actions a phone may make. */
export const EDA_EDIT_ACTIONS: readonly string[] = ['move', 'rotate', 'delete', 'setField'];

/** Requests a phone may send, and the permission each needs ('eda' depends on the command). */
export const PHONE_REQUESTS: Readonly<Record<string, CompanionPermission | 'eda'>> = {
	'views': 'view',
	'view.open': 'view',
	'eda': 'eda',
	'select': 'view',
	'follow': 'view',
	'cad.scene': 'view',
	'cad.properties': 'view',
	'cad.setProperty': 'edit',
	'sim.load': 'view',
	'sim.state': 'view',
	'sim.prepare': 'edit',
	'sim.run': 'edit',
	'sim.pause': 'edit',
	'sim.step': 'edit',
	'sim.stop': 'edit',
	'sim.setSpeed': 'edit',
	'sim.input': 'edit',
	'sim.release': 'edit',
	'sim.sendSerial': 'edit',
	'sim.runScenarios': 'edit',
	'ping': 'view',
	/** The phone's Unlink: the laptop forgets it too. */
	'unlink': 'view',
	'bye': 'view',
};

/**
 * The permission an EDA request needs, from its triage.eda.v1 Request (decoded),
 * or undefined if a phone may never send it (open or close a file by path,
 * reload, route, place parts, draw wires or tracks, rename nets).
 */
export function edaPermission(request: Message): CompanionPermission | undefined {
	const commands = Object.keys(request).filter(key => key !== 'id' && request[key] !== undefined);
	if (commands.length !== 1) {
		return undefined;
	}
	const [command] = commands;
	if (EDA_VIEW_COMMANDS.includes(command)) {
		return 'view';
	}
	if (!EDA_EDIT_COMMANDS.includes(command)) {
		return undefined;
	}
	if (command === 'edit') {
		const edit: Message = request['edit'] ?? {};
		const actions = Object.keys(edit).filter(key => key !== 'document' && edit[key] !== undefined);
		return actions.length === 1 && EDA_EDIT_ACTIONS.includes(actions[0]) ? 'edit' : undefined;
	}
	return 'edit';
}

/** Whether `granted` covers `needed`. */
export function permits(granted: CompanionPermission, needed: CompanionPermission): boolean {
	return granted === 'edit' || needed === 'view';
}
