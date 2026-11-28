/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The phone's end of a companion session (ROADMAP PC-2, PC-3): the handshake over
 *  any link (WebTransport on the LAN, a WebSocket through the relay), then sealed
 *  envelopes both ways: requests with replies, and the laptop's events.
 *  No VS Code imports: the phone app and the scripted-phone tests use this file.
 *--------------------------------------------------------------------------------------------*/

import { encodeFrame } from '../engineProtocol.js';
import { InitiatorOptions, NoiseChannel, NoiseInitiator } from './noise.js';
import { COMPANION_PROTOCOL, CompanionEnvelope, CompanionHello, decodeEnvelope, encodeEnvelope } from './protocol.js';
import { CompanionFrame, describeRefusal, encodeInit, parseRefusal } from './wire.js';

/** A connection that carries whole companion frames. */
export interface CompanionLink {
	readonly route: 'lan' | 'relay';
	send(frame: Uint8Array): Promise<void>;
	/** Set once, before the first frame can arrive. */
	setHandlers(onFrame: (type: number, payload: Uint8Array) => void, onClose: (reason: string) => void): void;
	close(): void;
}

/** Why a session ended: a refusal from the laptop (reason names, wire.ts) or the link. */
export class CompanionClosed extends Error {
	constructor(readonly reason: string, readonly text: string) {
		super(describeRefusal(reason, text));
	}
}

type Listener<T> = (value: T) => void;

class Listeners<T> {
	private readonly set = new Set<Listener<T>>();
	add(listener: Listener<T>): () => void {
		this.set.add(listener);
		return () => this.set.delete(listener);
	}
	fire(value: T): void {
		for (const listener of [...this.set]) {
			try {
				listener(value);
			} catch (error) {
				console.error(error);
			}
		}
	}
}

export interface SessionOptions extends InitiatorOptions {
	readonly hello: Omit<CompanionHello, 'protocol'> & { protocol?: number };
	/** Time for the laptop's reply, ms. */
	readonly timeoutMs?: number;
}

export class CompanionSession {
	private readonly events = new Listeners<CompanionEnvelope>();
	private readonly closes = new Listeners<CompanionClosed>();
	private readonly pending = new Map<number, { resolve: (e: CompanionEnvelope) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private sendChain: Promise<void> = Promise.resolve();
	private receiveChain: Promise<void> = Promise.resolve();
	private closedWith: CompanionClosed | undefined;
	/** Bytes received and sent (application messages), for the phone's numbers. */
	bytesIn = 0;
	bytesOut = 0;

	private constructor(private readonly link: CompanionLink, private readonly channel: NoiseChannel) { }

	/** The six digits to compare with the laptop's screen. */
	get sas(): string {
		return this.channel.sas;
	}

	get route(): 'lan' | 'relay' {
		return this.link.route;
	}

	get closed(): CompanionClosed | undefined {
		return this.closedWith;
	}

	/**
	 * Runs the handshake on an open link and sends the hello. Resolves once the
	 * laptop's reply checked out (the six digits are ready); the laptop then asks
	 * its user, and sends `event:welcome` or closes.
	 */
	static async start(link: CompanionLink, options: SessionOptions): Promise<CompanionSession> {
		const initiator = new NoiseInitiator(options);
		let session: CompanionSession | undefined;
		let replied = false;
		const early: [number, Uint8Array][] = [];
		const reply = new Promise<Uint8Array>((resolve, reject) => {
			const timer = setTimeout(() => reject(new CompanionClosed('idle', 'no answer from the laptop')), options.timeoutMs ?? 15_000);
			link.setHandlers((type, payload) => {
				if (session) {
					session.onFrame(type, payload);
					return;
				}
				if (replied) {
					// Arrived while the reply was being read.
					early.push([type, payload]);
					return;
				}
				replied = true;
				clearTimeout(timer);
				if (type === CompanionFrame.Reply) {
					resolve(payload);
				} else if (type === CompanionFrame.Refused) {
					const { reason, text } = parseRefusal(payload);
					reject(new CompanionClosed(reason, text));
				} else {
					reject(new CompanionClosed('protocol', `unexpected frame ${type}`));
				}
			}, reason => {
				clearTimeout(timer);
				if (session) {
					session.onClosed(new CompanionClosed('closed', reason));
				} else {
					reject(new CompanionClosed('closed', reason));
				}
			});
		});
		try {
			await link.send(encodeInit(options.mode, options.id, await initiator.writeInit()));
			const { channel } = await initiator.readReply(await reply);
			session = new CompanionSession(link, channel);
			for (const [type, payload] of early.splice(0)) {
				session.onFrame(type, payload);
			}
			session.send({ kind: 'hello', json: JSON.stringify({ protocol: COMPANION_PROTOCOL, ...options.hello }) });
			return session;
		} catch (error) {
			link.close();
			throw error instanceof CompanionClosed ? error : new CompanionClosed('handshake-failed', error instanceof Error ? error.message : String(error));
		}
	}

	/** Listens to the laptop's events (envelopes that answer no request). */
	onEvent(listener: Listener<CompanionEnvelope>): () => void {
		return this.events.add(listener);
	}

	onClose(listener: Listener<CompanionClosed>): () => void {
		return this.closes.add(listener);
	}

	/** Sends a request; resolves with the laptop's reply, rejects with its error. */
	request(kind: string, body?: unknown, blobs: readonly Uint8Array[] = []): Promise<CompanionEnvelope> {
		if (this.closedWith) {
			return Promise.reject(this.closedWith);
		}
		const id = this.nextId++;
		return new Promise<CompanionEnvelope>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ id, kind, json: body === undefined ? '' : JSON.stringify(body), blobs });
		});
	}

	/** Sends a message that wants no reply. */
	notify(kind: string, body?: unknown): void {
		this.send({ kind, json: body === undefined ? '' : JSON.stringify(body) });
	}

	private send(envelope: Partial<CompanionEnvelope> & { kind: string }): void {
		const bytes = encodeEnvelope(envelope);
		this.bytesOut += bytes.byteLength;
		// Nonces are taken when seal() is called: seal and send in one chain.
		this.sendChain = this.sendChain.then(async () => {
			for (const sealed of await this.channel.seal(bytes)) {
				await this.link.send(encodeFrame(CompanionFrame.Sealed, sealed));
			}
		}).catch(error => this.onClosed(new CompanionClosed('closed', String(error))));
	}

	private onFrame(type: number, payload: Uint8Array): void {
		if (type === CompanionFrame.Refused) {
			const { reason, text } = parseRefusal(payload);
			this.onClosed(new CompanionClosed(reason, text));
			return;
		}
		if (type !== CompanionFrame.Sealed) {
			this.onClosed(new CompanionClosed('protocol', `unexpected frame ${type}`));
			return;
		}
		this.receiveChain = this.receiveChain.then(async () => {
			const message = await this.channel.open(payload);
			if (!message) {
				return;
			}
			this.bytesIn += message.byteLength;
			const envelope = decodeEnvelope(message);
			const waiting = envelope.replyTo ? this.pending.get(envelope.replyTo) : undefined;
			if (waiting) {
				this.pending.delete(envelope.replyTo);
				if (envelope.error) {
					waiting.reject(new Error(envelope.error));
				} else {
					waiting.resolve(envelope);
				}
			} else {
				this.events.fire(envelope);
			}
		}).catch(error => this.onClosed(new CompanionClosed('protocol', String(error))));
	}

	private onClosed(closed: CompanionClosed): void {
		if (this.closedWith) {
			return;
		}
		this.closedWith = closed;
		for (const waiting of this.pending.values()) {
			waiting.reject(closed);
		}
		this.pending.clear();
		this.link.close();
		this.closes.fire(closed);
	}

	/** Says goodbye and closes. */
	close(): void {
		if (!this.closedWith) {
			this.notify('bye');
			void this.sendChain.finally(() => this.onClosed(new CompanionClosed('closed', 'the phone closed the connection')));
		}
	}
}

/** Parses an event's JSON body (an empty body is undefined). */
export function body<T>(envelope: CompanionEnvelope): T {
	return (envelope.json ? JSON.parse(envelope.json) : undefined) as T;
}
