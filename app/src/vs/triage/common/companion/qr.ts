/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The pairing QR code's payload (ROADMAP PC-2, PLAN §4.16 "Pairing in detail"),
 *  as crates/triage-companion/src/qr.rs writes it, and the typed code.
 *  No VS Code imports: the phone app bundles this file.
 *--------------------------------------------------------------------------------------------*/

export const QR_VERSION = 1;
export const COMPANION_VIEWS = ['board', 'schematic', '3d', 'sim'] as const;
export type CompanionView = typeof COMPANION_VIEWS[number];

export interface QrPayload {
	readonly id: Uint8Array;
	readonly secret: Uint8Array;
	readonly laptopKey: Uint8Array;
	readonly certificateHash: Uint8Array;
	/** Unix seconds. */
	readonly expires: number;
	readonly view: CompanionView;
	/** host:port, IPv6 hosts in brackets. */
	readonly addresses: readonly string[];
	readonly relay?: string;
}

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) {
		throw new Error('not base64url');
	}
	const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

class Reader {
	private at = 0;
	constructor(private readonly bytes: Uint8Array) { }

	take(n: number): Uint8Array {
		if (this.at + n > this.bytes.byteLength) {
			throw new Error('short QR payload');
		}
		const out = this.bytes.slice(this.at, this.at + n);
		this.at += n;
		return out;
	}

	u8(): number {
		return this.take(1)[0];
	}

	get done(): boolean {
		return this.at === this.bytes.byteLength;
	}
}

/** Reads a QR payload's bytes. */
export function decodeQrPayload(bytes: Uint8Array): QrPayload {
	const r = new Reader(bytes);
	if (r.u8() !== QR_VERSION) {
		throw new Error('This QR code is from another Triage version.');
	}
	const flags = r.u8();
	const id = r.take(16);
	const secret = r.take(32);
	const laptopKey = r.take(32);
	const certificateHash = r.take(32);
	const expires = new DataView(r.take(4).buffer).getUint32(0, false);
	const view = COMPANION_VIEWS[r.u8()];
	if (!view) {
		throw new Error('unknown view');
	}
	const count = r.u8();
	if (count > 3) {
		throw new Error('too many addresses');
	}
	const addresses: string[] = [];
	for (let i = 0; i < count; i++) {
		const family = r.u8();
		let host: string;
		if (family === 4) {
			host = Array.from(r.take(4)).join('.');
		} else if (family === 6) {
			const b = r.take(16);
			const groups: string[] = [];
			for (let g = 0; g < 8; g++) {
				groups.push(((b[2 * g] << 8) | b[2 * g + 1]).toString(16));
			}
			host = `[${groups.join(':')}]`;
		} else {
			throw new Error('unknown address family');
		}
		const port = new DataView(r.take(2).buffer).getUint16(0, false);
		addresses.push(`${host}:${port}`);
	}
	let relay: string | undefined;
	if (flags & 1) {
		relay = new TextDecoder('utf-8', { fatal: true }).decode(r.take(r.u8()));
	}
	if (!r.done) {
		throw new Error('trailing bytes in the QR payload');
	}
	return { id, secret, laptopKey, certificateHash, expires, view, addresses, relay };
}

/** Reads the payload of a pairing link (`…/p#<payload>`, `…#p=<payload>`) or a bare payload. */
export function decodePairingLink(link: string): QrPayload {
	const hash = link.includes('#') ? link.slice(link.lastIndexOf('#') + 1) : link;
	return decodeQrPayload(base64UrlDecode(hash.replace(/^p=/, '')));
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A typed code as the handshake uses it (qr.rs `normalize_code`), or undefined. */
export function normalizeCode(code: string): string | undefined {
	let out = '';
	for (const raw of code.toUpperCase()) {
		if (raw === '-' || raw === ' ') {
			continue;
		}
		const c = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
		if (!CODE_ALPHABET.includes(c)) {
			return undefined;
		}
		out += c;
	}
	return out.length === 8 ? out : undefined;
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function formatCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}
