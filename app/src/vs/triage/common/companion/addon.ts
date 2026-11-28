/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The shape of triage_companion.node (crates/triage-companion-node), which the
 *  companion broker loads (node/companionBrokerMain.ts) and the tests drive.
 *--------------------------------------------------------------------------------------------*/

export const COMPANION_ADDON = 'triage_companion.node';

export interface CompanionCertificate {
	readonly der: Uint8Array;
	readonly keyDer: Uint8Array;
	/** Unix s. */
	readonly notBefore: number;
	/** Unix s. */
	readonly notAfter: number;
	readonly hash: Uint8Array;
}

export interface CompanionAddonEvent {
	readonly kind: 'handshake' | 'message' | 'closed' | 'failed' | 'relay';
	readonly session?: number;
	readonly mode?: 'pair' | 'reconnect' | 'code';
	readonly id?: Uint8Array;
	readonly phoneKey?: Uint8Array;
	readonly sas?: string;
	readonly route?: 'lan' | 'relay';
	readonly remote?: string;
	readonly data?: Uint8Array;
	readonly reason?: string;
	readonly attempts?: number;
	readonly connected?: boolean;
}

export interface CompanionQrPayload {
	readonly id: Uint8Array;
	readonly secret: Uint8Array;
	readonly laptopKey: Uint8Array;
	readonly certificateHash: Uint8Array;
	/** Unix s. */
	readonly expires: number;
	readonly view: 'board' | 'schematic' | '3d' | 'sim';
	readonly addresses: readonly string[];
	readonly relay?: string | null;
}

export interface ICompanionServer {
	listen(port: number, certificate: CompanionCertificate): Promise<number>;
	setCertificate(certificate: CompanionCertificate): Promise<void>;
	stopListening(): void;
	port(): number | null;
	setStaticKey(privateKey: Uint8Array): void;
	setAllowedOrigins(origins: readonly string[]): void;
	addPairing(id: Uint8Array, mode: 'pair' | 'code', psk: Uint8Array, expiresMs: number): void;
	removePairing(id: Uint8Array): void;
	consumePairing(id: Uint8Array): void;
	failPairing(id: Uint8Array): number;
	setPhones(phones: readonly { mailbox: Uint8Array; key: Uint8Array }[]): void;
	send(session: number, data: Uint8Array): boolean;
	sendWait(session: number, data: Uint8Array): Promise<boolean>;
	close(session: number, refusal: string, text: string): Promise<void>;
	sessions(): number;
	setRelay(url: string | null, mailboxes: readonly Uint8Array[]): Promise<void>;
	nextEvent(): Promise<CompanionAddonEvent | null>;
	shutdown(): Promise<void>;
}

export interface ICompanionAddon {
	CompanionServer: new (staticPrivate: Uint8Array) => ICompanionServer;
	generateKeypair(): { private: Uint8Array; public: Uint8Array };
	publicKey(privateKey: Uint8Array): Uint8Array;
	planCertificates(certificates: readonly CompanionCertificate[], now: number): CompanionCertificate[];
	currentCertificate(certificates: readonly CompanionCertificate[], now: number): CompanionCertificate | null;
	generateCertificate(notBefore: number): CompanionCertificate;
	qrLink(payload: CompanionQrPayload, appUrl: string): string;
	qrPayload(link: string): CompanionQrPayload;
	qrModules(text: string): { width: number; dark: Uint8Array };
	randomBytes(n: number): Uint8Array;
	newCode(): string;
	normalizeCode(code: string): string | null;
	codePsk(code: string): Uint8Array;
	codeMailbox(code: string): Uint8Array;
	rankAddresses(ips: readonly string[], port: number): string[];
	protocolVersion(): number;
	TestResponder: new (mode: string, id: Uint8Array, staticPrivate: Uint8Array, psk?: Uint8Array | null) => {
		readInit(message: Uint8Array): Uint8Array;
		remoteStatic(): Uint8Array | null;
		writeReply(payload: Uint8Array): Uint8Array;
		sas(): string;
		seal(message: Uint8Array): Uint8Array[];
		open(sealed: Uint8Array): Uint8Array | null;
	};
}
