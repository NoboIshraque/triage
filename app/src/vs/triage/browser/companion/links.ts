/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  How a phone reaches the laptop (ROADMAP PC-1, PC-7; PLAN §4.16 "Transport"):
 *  WebTransport straight to the laptop's LAN address with its certificate pinned
 *  by hash (no warning page, no certificate authority, no internet), or a
 *  WebSocket to the relay, which forwards sealed frames between the phone and
 *  the laptop's mailbox. No VS Code imports: the phone app bundles this file.
 *--------------------------------------------------------------------------------------------*/

import { FrameDecoder } from '../../common/engineProtocol.js';
import { CompanionLink } from '../../common/companion/session.js';
import { MAX_COMPANION_FRAME_BODY, parseWholeFrame } from '../../common/companion/wire.js';

/** The path the laptop serves (crates/triage-companion server::PATH). */
export const COMPANION_PATH = '/triage/v1';

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Whether this browser has WebTransport with certificate hashes (Chrome 100+, iOS 26.4+). */
export function hasWebTransport(): boolean {
	return typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function';
}

/** WebTransport to one LAN address (`host:port`). */
export class WebTransportLink implements CompanionLink {
	readonly route = 'lan' as const;
	private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
	private onFrame: ((type: number, payload: Uint8Array) => void) | undefined;
	private onClose: ((reason: string) => void) | undefined;
	private closed = false;

	private constructor(private readonly transport: WebTransport) { }

	/** Connects, pinning any of `hashes` (SHA-256 of the laptop's certificates). */
	static async open(address: string, hashes: readonly Uint8Array[], timeoutMs = 4000): Promise<WebTransportLink> {
		const transport = new WebTransport(`https://${address}${COMPANION_PATH}`, {
			allowPooling: false,
			serverCertificateHashes: hashes.map(value => ({ algorithm: 'sha-256', value: value.slice().buffer as ArrayBuffer })),
		} as WebTransportOptions);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				transport.ready,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer from ${address}`)), timeoutMs); }),
			]);
		} catch (error) {
			transport.close();
			throw error;
		} finally {
			clearTimeout(timer);
		}
		const link = new WebTransportLink(transport);
		const stream = await transport.createBidirectionalStream();
		link.writer = stream.writable.getWriter();
		void link.read(stream.readable.getReader());
		void transport.closed.then(() => link.finish('closed'), (error: unknown) => link.finish(String(error)));
		return link;
	}

	setHandlers(onFrame: (type: number, payload: Uint8Array) => void, onClose: (reason: string) => void): void {
		this.onFrame = onFrame;
		this.onClose = onClose;
	}

	private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		const decoder = new FrameDecoder();
		try {
			for (; ;) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				for (const frame of decoder.push(value)) {
					if (frame.payload.byteLength + 1 > MAX_COMPANION_FRAME_BODY) {
						throw new Error('frame too large');
					}
					this.onFrame?.(frame.type, frame.payload);
				}
			}
			this.finish('the laptop closed the stream');
		} catch (error) {
			this.finish(String(error));
		}
	}

	async send(frame: Uint8Array): Promise<void> {
		if (!this.writer || this.closed) {
			throw new Error('the connection is closed');
		}
		await this.writer.write(frame);
	}

	private finish(reason: string): void {
		if (!this.closed) {
			this.closed = true;
			this.onClose?.(reason);
		}
	}

	close(): void {
		this.finish('closed');
		try {
			this.transport.close();
		} catch {
			// already closed
		}
	}
}

/** A WebSocket to the relay, in a mailbox (16 bytes); one frame per message. */
export class RelayLink implements CompanionLink {
	readonly route = 'relay' as const;
	private onFrame: ((type: number, payload: Uint8Array) => void) | undefined;
	private onClose: ((reason: string) => void) | undefined;
	private closed = false;

	private constructor(private readonly socket: WebSocket) {
		socket.binaryType = 'arraybuffer';
		socket.addEventListener('message', event => {
			if (!(event.data instanceof ArrayBuffer)) {
				return; // the relay's own notes (text) aren't frames
			}
			try {
				const frame = parseWholeFrame(new Uint8Array(event.data));
				this.onFrame?.(frame.type, frame.payload);
			} catch (error) {
				this.finish(String(error));
				socket.close();
			}
		});
		socket.addEventListener('close', event => this.finish(event.reason || `the relay closed the connection (${event.code})`));
	}

	static async open(relay: string, mailbox: Uint8Array, timeoutMs = 8000): Promise<RelayLink> {
		const socket = new WebSocket(`${relay.replace(/\/+$/, '')}/v1/${hex(mailbox)}?role=phone`);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { socket.close(); reject(new Error('no answer from the relay')); }, timeoutMs);
			socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
			socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the relay could not be reached')); }, { once: true });
		});
		return new RelayLink(socket);
	}

	setHandlers(onFrame: (type: number, payload: Uint8Array) => void, onClose: (reason: string) => void): void {
		this.onFrame = onFrame;
		this.onClose = onClose;
	}

	async send(frame: Uint8Array): Promise<void> {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error('the connection is closed');
		}
		this.socket.send(new Uint8Array(frame));
	}

	private finish(reason: string): void {
		if (!this.closed) {
			this.closed = true;
			this.onClose?.(reason);
		}
	}

	close(): void {
		this.finish('closed');
		this.socket.close();
	}
}

/**
 * The LAN first (every address the laptop gave, at once), then the relay.
 * Resolves with the first link that opens.
 */
export async function connect(target: { addresses: readonly string[]; hashes: readonly Uint8Array[]; relay?: string; mailbox: Uint8Array }): Promise<CompanionLink> {
	const errors: string[] = [];
	if (hasWebTransport() && target.addresses.length > 0 && target.hashes.length > 0) {
		try {
			return await Promise.any(target.addresses.map(address => WebTransportLink.open(address, target.hashes)));
		} catch (error) {
			errors.push(error instanceof AggregateError ? error.errors.map(String).join('; ') : String(error));
		}
	} else if (!hasWebTransport()) {
		errors.push('this browser has no WebTransport (iOS 26.4 or Chrome 100 needed for the direct path)');
	}
	if (target.relay) {
		try {
			return await RelayLink.open(target.relay, target.mailbox);
		} catch (error) {
			errors.push(String(error));
		}
	}
	throw new Error(`Couldn't reach the laptop: ${errors.join(' · ') || 'no address'}`);
}
