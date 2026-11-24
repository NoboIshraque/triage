/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Frames between an engine process and its broker (ROADMAP P0-4, PLAN §4.2):
 *    u32 little-endian length of (type + payload), u8 type, payload.
 *  Same layout as engines/hello/include/triage/hello/protocol.hpp.
 *  No VS Code imports: tested on its own in app/engine-tests.
 *--------------------------------------------------------------------------------------------*/

export const FrameType = {
	Hello: 0x01,
	Ping: 0x02,
	Pong: 0x03,
	Stream: 0x10,
	Data: 0x11,
	StreamEnd: 0x12,
	Error: 0x7f,
} as const;

export type FrameTypeValue = typeof FrameType[keyof typeof FrameType];

/** Largest frame body (type + payload): 64 MiB, as in the engine. */
export const MAX_FRAME_BODY = 64 * 1024 * 1024;

export const FRAME_HEADER = 5;

export interface Frame {
	readonly type: number;
	readonly payload: Uint8Array;
}

export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
	const frame = new Uint8Array(FRAME_HEADER + payload.byteLength);
	new DataView(frame.buffer).setUint32(0, payload.byteLength + 1, true);
	frame[4] = type;
	frame.set(payload, FRAME_HEADER);
	return frame;
}

export function encodeStreamRequest(count: number, frameSize: number): Uint8Array {
	const payload = new Uint8Array(8);
	const view = new DataView(payload.buffer);
	view.setUint32(0, count, true);
	view.setUint32(4, frameSize, true);
	return encodeFrame(FrameType.Stream, payload);
}

export class FrameError extends Error { }

/**
 * Splits a byte stream into frames. Chunks are kept as they arrive and copied
 * once per frame, so large frames in small chunks cost linear time.
 */
export class FrameDecoder {
	private readonly chunks: Uint8Array[] = [];
	private buffered = 0;

	push(chunk: Uint8Array): Frame[] {
		if (chunk.byteLength > 0) {
			this.chunks.push(chunk);
			this.buffered += chunk.byteLength;
		}
		const frames: Frame[] = [];
		while (this.buffered >= FRAME_HEADER) {
			const header = this.peek(FRAME_HEADER);
			const body = new DataView(header.buffer, header.byteOffset, FRAME_HEADER).getUint32(0, true);
			if (body === 0 || body > MAX_FRAME_BODY) {
				throw new FrameError(`invalid frame length ${body}`);
			}
			if (this.buffered < 4 + body) {
				break;
			}
			const frame = this.take(4 + body);
			frames.push({ type: frame[4], payload: frame.subarray(FRAME_HEADER) });
		}
		return frames;
	}

	/** The first `size` bytes, without consuming them. */
	private peek(size: number): Uint8Array {
		const first = this.chunks[0];
		if (first.byteLength >= size) {
			return first.subarray(0, size);
		}
		const out = new Uint8Array(size);
		let filled = 0;
		for (const chunk of this.chunks) {
			const part = chunk.subarray(0, Math.min(chunk.byteLength, size - filled));
			out.set(part, filled);
			filled += part.byteLength;
			if (filled === size) {
				break;
			}
		}
		return out;
	}

	/** Removes and returns the first `size` bytes. */
	private take(size: number): Uint8Array {
		const first = this.chunks[0];
		if (first.byteLength >= size) {
			const out = first.subarray(0, size);
			if (first.byteLength === size) {
				this.chunks.shift();
			} else {
				this.chunks[0] = first.subarray(size);
			}
			this.buffered -= size;
			return out;
		}
		const out = new Uint8Array(size);
		let filled = 0;
		while (filled < size) {
			const chunk = this.chunks[0];
			const needed = size - filled;
			if (chunk.byteLength <= needed) {
				out.set(chunk, filled);
				filled += chunk.byteLength;
				this.chunks.shift();
			} else {
				out.set(chunk.subarray(0, needed), filled);
				this.chunks[0] = chunk.subarray(needed);
				filled = size;
			}
		}
		this.buffered -= size;
		return out;
	}
}

export function readU64(payload: Uint8Array): number {
	return Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true));
}

const textDecoder = new TextDecoder();

export function frameText(frame: Frame): string {
	return textDecoder.decode(frame.payload);
}

/** Parses the engine's Hello payload: "<name> <version> <pid>". */
export function parseHello(text: string): { name: string; version: string; pid: number } | undefined {
	const match = /^(\S+) (\S+) (\d+)$/.exec(text);
	return match ? { name: match[1], version: match[2], pid: Number(match[3]) } : undefined;
}
