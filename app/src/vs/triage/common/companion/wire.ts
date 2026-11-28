/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The companion's wire frames (ROADMAP PC-2, PLAN §4.16): the engine connection's
 *  layout (engineProtocol.ts) with the companion's frame types. Mirrors
 *  crates/triage-companion/src/wire.rs, which the laptop runs.
 *  No VS Code imports: the phone app (companion/web) bundles this file.
 *--------------------------------------------------------------------------------------------*/

import { encodeFrame, FRAME_HEADER } from '../engineProtocol.js';

export const CompanionFrame = {
	/** Phone → laptop: init header, then the first handshake message. */
	Init: 0x20,
	/** Laptop → phone: the second handshake message. */
	Reply: 0x21,
	/** One Noise transport message. */
	Sealed: 0x22,
	/** Laptop → phone, unencrypted, before closing: a refusal byte and a short text. */
	Refused: 0x23,
} as const;

/** The wire protocol's version (the init header's first byte). */
export const WIRE_VERSION = 1;
/** Noise's limit on one message. */
export const NOISE_MAX = 65535;
/** Largest frame body: one Noise message and the init header. */
export const MAX_COMPANION_FRAME_BODY = 1 + 18 + NOISE_MAX;

export type CompanionMode = 'pair' | 'reconnect' | 'code';
const MODE_BYTE: Record<CompanionMode, number> = { pair: 1, reconnect: 2, code: 3 };

/** Why the laptop refused or closed (crates/triage-companion wire::Refusal). */
export const REFUSALS = ['', 'incompatible', 'expired', 'not-paired', 'too-many-attempts', 'busy', 'denied', 'handshake-failed', 'limits', 'closed', 'protocol', 'idle'] as const;
export type RefusalName = typeof REFUSALS[number];

/** A refusal in words, for the phone's screen. */
export function describeRefusal(name: string, text = ''): string {
	const words: Record<string, string> = {
		'incompatible': 'This phone app and Triage on the laptop are different versions. Update Triage, or reload the phone app.',
		'expired': 'This QR code has expired or was already used. On the laptop, click Show again and scan the new code.',
		'not-paired': 'The laptop doesn\'t know this phone any more (it was removed). Pair it again with a new QR code.',
		'too-many-attempts': 'Too many failed attempts with this code. On the laptop, click Show again for a new one.',
		'busy': 'Another phone is answering this QR code right now. Wait, or show a new code on the laptop.',
		'denied': 'The laptop said no.',
		'handshake-failed': 'The secure connection failed (a wrong or old code). Scan the QR code again.',
		'limits': 'The phone sent too much too fast, and the laptop closed the connection.',
		'closed': 'The laptop stopped sharing.',
		'protocol': 'The phone app sent something the laptop didn\'t expect. Reload the app.',
		'idle': 'The connection timed out.',
	};
	const sentence = words[name] ?? `The laptop closed the connection (${name}).`;
	return text ? `${sentence} (${text})` : sentence;
}

/** The init frame's payload: version, mode, 16-byte id, then the handshake message. */
export function encodeInit(mode: CompanionMode, id: Uint8Array, message: Uint8Array): Uint8Array {
	if (id.byteLength !== 16) {
		throw new Error('the id must be 16 bytes');
	}
	const payload = new Uint8Array(18 + message.byteLength);
	payload[0] = WIRE_VERSION;
	payload[1] = MODE_BYTE[mode];
	payload.set(id, 2);
	payload.set(message, 18);
	return encodeFrame(CompanionFrame.Init, payload);
}

/** The init header bytes (the Noise prologue binds them). */
export function initHeader(mode: CompanionMode, id: Uint8Array): Uint8Array {
	const header = new Uint8Array(18);
	header[0] = WIRE_VERSION;
	header[1] = MODE_BYTE[mode];
	header.set(id, 2);
	return header;
}

/** A refused frame's reason and text. */
export function parseRefusal(payload: Uint8Array): { reason: string; text: string } {
	return {
		reason: REFUSALS[payload[0]] || `unknown-${payload[0]}`,
		text: new TextDecoder().decode(payload.subarray(1)),
	};
}

/** Parses one frame that arrived whole (a relay WebSocket message). */
export function parseWholeFrame(bytes: Uint8Array): { type: number; payload: Uint8Array } {
	if (bytes.byteLength < FRAME_HEADER) {
		throw new Error('short frame');
	}
	const body = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
	if (body === 0 || body > MAX_COMPANION_FRAME_BODY || bytes.byteLength !== 4 + body) {
		throw new Error(`invalid frame length ${body}`);
	}
	return { type: bytes[4], payload: bytes.subarray(FRAME_HEADER) };
}
