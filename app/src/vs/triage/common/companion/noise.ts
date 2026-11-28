/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The phone's side of the companion's Noise handshakes (ROADMAP PC-2, PLAN §4.16),
 *  in WebCrypto only (X25519, AES-256-GCM, SHA-256, HMAC): the same handshakes as
 *  crates/triage-companion/src/noise.rs, which the laptop runs with `snow`.
 *
 *    pair       Noise_IKpsk2_25519_AESGCM_SHA256   the QR's laptop key and one-time secret
 *    reconnect  Noise_IK_25519_AESGCM_SHA256       the pinned laptop key
 *    code       Noise_NNpsk0_25519_AESGCM_SHA256   a typed code stretched with PBKDF2
 *
 *  The phone's static key is a non-extractable CryptoKey: its private half never
 *  leaves WebCrypto. No VS Code imports: the phone app bundles this file.
 *--------------------------------------------------------------------------------------------*/

import { CompanionMode, initHeader, NOISE_MAX } from './wire.js';

const encoder = new TextEncoder();
const PROLOGUE = encoder.encode('triage-companion/1');
const PATTERNS: Record<CompanionMode, string> = {
	pair: 'Noise_IKpsk2_25519_AESGCM_SHA256',
	reconnect: 'Noise_IK_25519_AESGCM_SHA256',
	code: 'Noise_NNpsk0_25519_AESGCM_SHA256',
};
export const TAG = 16;
export const MAX_FRAGMENT = NOISE_MAX - TAG - 1;
export const CODE_ITERATIONS = 1 << 17;
const FLAG_MORE = 1;

function subtle(): SubtleCrypto {
	const crypto = globalThis.crypto;
	if (!crypto?.subtle) {
		throw new Error('WebCrypto is not available here (the page must be served over HTTPS)');
	}
	return crypto.subtle;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

/** A view WebCrypto accepts (an ArrayBuffer-backed copy). */
function buf(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer as ArrayBuffer;
}

export async function sha256(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
	return new Uint8Array(await subtle().digest('SHA-256', buf(concat(...parts))));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return new Uint8Array(await subtle().sign('HMAC', k, buf(data)));
}

/** Noise's HKDF: two or three 32-byte outputs. */
async function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Promise<Uint8Array[]> {
	const temp = await hmac(chainingKey, input);
	const o1 = await hmac(temp, Uint8Array.of(1));
	const o2 = await hmac(temp, concat(o1, Uint8Array.of(2)));
	if (outputs === 2) {
		return [o1, o2];
	}
	return [o1, o2, await hmac(temp, concat(o2, Uint8Array.of(3)))];
}

/** An X25519 key pair; the private half is a CryptoKey. */
export interface NoiseKeyPair {
	readonly privateKey: CryptoKey;
	readonly publicKey: Uint8Array;
}

/** A new X25519 key pair. The phone's static key is made non-extractable. */
export async function generateKeyPair(extractable = false): Promise<NoiseKeyPair> {
	const pair = await subtle().generateKey({ name: 'X25519' }, extractable, ['deriveBits']) as CryptoKeyPair;
	return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}

/** Whether this browser has X25519 in WebCrypto (Chrome 133+, Safari 17+). */
export async function hasX25519(): Promise<boolean> {
	try {
		await generateKeyPair(false);
		return true;
	} catch {
		return false;
	}
}

async function dh(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
	const key = await subtle().importKey('raw', buf(publicKey), { name: 'X25519' }, false, []);
	return new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: key } as unknown as AlgorithmIdentifier, privateKey, 256));
}

/** One direction of a Noise session: AES-256-GCM with a 64-bit counter nonce. */
export class CipherState {
	private key: CryptoKey | undefined;
	private n = 0n;

	async init(key: Uint8Array): Promise<void> {
		this.key = await subtle().importKey('raw', buf(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
		this.n = 0n;
	}

	get hasKey(): boolean {
		return this.key !== undefined;
	}

	/** Takes the next nonce now, so calls made in order use nonces in order. */
	private nextNonce(): Uint8Array {
		const nonce = new Uint8Array(12);
		new DataView(nonce.buffer).setBigUint64(4, this.n, false);
		this.n++;
		return nonce;
	}

	encrypt(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
		if (!this.key) {
			return Promise.resolve(plaintext);
		}
		const iv = this.nextNonce();
		return subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(ad), tagLength: 128 }, this.key, buf(plaintext)).then(c => new Uint8Array(c));
	}

	decrypt(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
		if (!this.key) {
			return Promise.resolve(ciphertext);
		}
		const iv = this.nextNonce();
		return subtle().decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(ad), tagLength: 128 }, this.key, buf(ciphertext)).then(p => new Uint8Array(p));
	}
}

class SymmetricState {
	ck: Uint8Array;
	h: Uint8Array;
	readonly cipher = new CipherState();

	constructor(protocol: string) {
		const name = encoder.encode(protocol);
		if (name.byteLength > 32) {
			throw new Error('protocol names here are at most 32 bytes');
		}
		this.h = new Uint8Array(32);
		this.h.set(name);
		this.ck = this.h.slice();
	}

	async mixHash(data: Uint8Array): Promise<void> {
		this.h = await sha256(this.h, data);
	}

	async mixKey(input: Uint8Array): Promise<void> {
		const [ck, key] = await hkdf(this.ck, input, 2);
		this.ck = ck;
		await this.cipher.init(key);
	}

	async mixKeyAndHash(input: Uint8Array): Promise<void> {
		const [ck, tempH, key] = await hkdf(this.ck, input, 3);
		this.ck = ck;
		await this.mixHash(tempH);
		await this.cipher.init(key);
	}

	async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
		const ciphertext = await this.cipher.encrypt(this.h, plaintext);
		await this.mixHash(ciphertext);
		return ciphertext;
	}

	async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
		const plaintext = await this.cipher.decrypt(this.h, ciphertext);
		await this.mixHash(ciphertext);
		return plaintext;
	}

	async split(): Promise<[CipherState, CipherState]> {
		const [k1, k2] = await hkdf(this.ck, new Uint8Array(0), 2);
		const c1 = new CipherState();
		const c2 = new CipherState();
		await c1.init(k1);
		await c2.init(k2);
		return [c1, c2];
	}
}

/** The six digits both screens show, from the handshake hash (noise.rs `sas`). */
export async function shortCode(handshakeHash: Uint8Array): Promise<string> {
	const digest = await sha256(encoder.encode('triage-companion-sas/1'), handshakeHash);
	const n = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false) % 1_000_000;
	return String(n).padStart(6, '0');
}

/** The PSK of a normalized typed code (PBKDF2-HMAC-SHA-256, 2^17 iterations). */
export async function codePsk(code: string): Promise<Uint8Array> {
	const key = await subtle().importKey('raw', buf(encoder.encode(code)), 'PBKDF2', false, ['deriveBits']);
	const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(encoder.encode('triage-companion-code/1')), iterations: CODE_ITERATIONS }, key, 256);
	return new Uint8Array(bits);
}

/** The relay mailbox of a normalized typed code. */
export async function codeMailbox(code: string): Promise<Uint8Array> {
	return (await sha256(encoder.encode('triage-companion-mailbox/1'), encoder.encode(code))).slice(0, 16);
}

/** What the phone needs to start a handshake. */
export interface InitiatorOptions {
	readonly mode: CompanionMode;
	/** The pairing id, the phone's mailbox, or the code's mailbox. */
	readonly id: Uint8Array;
	/** The phone's static key (pair, reconnect). */
	readonly staticKey?: NoiseKeyPair;
	/** The laptop's public key (pair, reconnect). */
	readonly laptopKey?: Uint8Array;
	/** The QR's secret (pair) or the code's key (code). */
	readonly psk?: Uint8Array;
}

/** A finished handshake: seals and opens application messages, in order. */
export class NoiseChannel {
	private partial: Uint8Array[] = [];
	private partialBytes = 0;

	constructor(
		private readonly sending: CipherState,
		private readonly receiving: CipherState,
		readonly handshakeHash: Uint8Array,
		readonly sas: string,
		private readonly maxMessage = 256 * 1024 * 1024,
	) { }

	/**
	 * Seals one message into Noise messages (fragments with a one-byte flag).
	 * Nonces are taken at the call, so seal() calls must be sent in call order.
	 */
	seal(message: Uint8Array): Promise<Uint8Array[]> {
		const pieces: Promise<Uint8Array>[] = [];
		const count = Math.max(1, Math.ceil(message.byteLength / MAX_FRAGMENT));
		for (let i = 0; i < count; i++) {
			const piece = message.subarray(i * MAX_FRAGMENT, (i + 1) * MAX_FRAGMENT);
			const plain = new Uint8Array(piece.byteLength + 1);
			plain[0] = i < count - 1 ? FLAG_MORE : 0;
			plain.set(piece, 1);
			pieces.push(this.sending.encrypt(new Uint8Array(0), plain));
		}
		return Promise.all(pieces);
	}

	/** Opens one Noise message; resolves with a message once its last fragment arrived. Call in arrival order. */
	async open(sealed: Uint8Array): Promise<Uint8Array | undefined> {
		if (sealed.byteLength < TAG + 1 || sealed.byteLength > NOISE_MAX) {
			throw new Error('sealed message of the wrong size');
		}
		const plain = await this.receiving.decrypt(new Uint8Array(0), sealed);
		const flags = plain[0];
		if (flags & ~FLAG_MORE) {
			throw new Error('unknown fragment flags');
		}
		this.partialBytes += plain.byteLength - 1;
		if (this.partialBytes > this.maxMessage) {
			throw new Error('message too large');
		}
		this.partial.push(plain.subarray(1));
		if (flags & FLAG_MORE) {
			return undefined;
		}
		const message = this.partial.length === 1 ? this.partial[0] : concat(...this.partial);
		this.partial = [];
		this.partialBytes = 0;
		return message;
	}
}

/** The phone's side of one handshake: writeInit(), then readReply(). */
export class NoiseInitiator {
	private readonly state: SymmetricState;
	private ephemeral: NoiseKeyPair | undefined;
	private started = false;

	constructor(private readonly options: InitiatorOptions) {
		this.state = new SymmetricState(PATTERNS[options.mode]);
		if (options.mode !== 'code' && (!options.staticKey || !options.laptopKey)) {
			throw new Error('pair and reconnect need the phone\'s key and the laptop\'s');
		}
		if ((options.mode === 'reconnect') === (options.psk !== undefined)) {
			throw new Error(options.mode === 'reconnect' ? 'reconnect takes no PSK' : `${options.mode} needs a PSK`);
		}
	}

	private get psk(): boolean {
		return this.options.mode !== 'reconnect';
	}

	/** The first handshake message (to follow the init header). */
	async writeInit(payload: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
		if (this.started) {
			throw new Error('writeInit twice');
		}
		this.started = true;
		const s = this.state;
		const { mode, id, staticKey, laptopKey, psk } = this.options;
		await s.mixHash(concat(PROLOGUE, initHeader(mode, id)));
		if (mode !== 'code') {
			await s.mixHash(laptopKey!); // <- s
		}
		if (mode === 'code') {
			await s.mixKeyAndHash(psk!); // psk0
		}
		const e = this.ephemeral = await generateKeyPair(false);
		const parts: Uint8Array[] = [e.publicKey];
		await s.mixHash(e.publicKey);
		if (this.psk) {
			await s.mixKey(e.publicKey);
		}
		if (mode !== 'code') {
			await s.mixKey(await dh(e.privateKey, laptopKey!)); // es
			parts.push(await s.encryptAndHash(staticKey!.publicKey)); // s
			await s.mixKey(await dh(staticKey!.privateKey, laptopKey!)); // ss
		}
		parts.push(await s.encryptAndHash(payload));
		return concat(...parts);
	}

	/** Reads the laptop's reply; fails on a wrong secret or someone in between. */
	async readReply(message: Uint8Array): Promise<{ payload: Uint8Array; channel: NoiseChannel }> {
		const e = this.ephemeral;
		if (!e || message.byteLength < 32 + TAG) {
			throw new Error('reply too short or out of turn');
		}
		const s = this.state;
		const re = message.subarray(0, 32);
		await s.mixHash(re);
		if (this.psk) {
			await s.mixKey(re);
		}
		await s.mixKey(await dh(e.privateKey, re)); // ee
		if (this.options.mode !== 'code') {
			await s.mixKey(await dh(this.options.staticKey!.privateKey, re)); // se
		}
		if (this.options.mode === 'pair') {
			await s.mixKeyAndHash(this.options.psk!); // psk2
		}
		const payload = await s.decryptAndHash(message.subarray(32));
		const [sending, receiving] = await s.split();
		const hash = s.h.slice();
		return { payload, channel: new NoiseChannel(sending, receiving, hash, await shortCode(hash)) };
	}
}
