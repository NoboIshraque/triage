/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The phone companion on the laptop (ROADMAP PC-2, ADR 0005): the window's
 *  ITriageCompanionService pairs phones, keeps their keys and permissions, and
 *  answers their requests with the window's engine services; the companion broker
 *  (node/companionBrokerMain.ts, a utility process with triage_companion.node)
 *  listens on the LAN and the relay and runs the Noise sessions.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { CompanionPermission } from './protocol.js';

export const COMPANION_BROKER_CHANNEL = 'triageCompanionBroker';
export const COMPANION_BROKER_MODULE = 'vs/triage/node/companionBrokerMain';
/** Where the packaged app keeps triage_companion.node (app/build.mjs engines). */
export const COMPANION_FOLDER = 'companion';
export const COMPANION_STATUS_ID = 'triage.companion';
/** UDP port phones reach the laptop on (WebTransport); a setting changes it. */
export const COMPANION_DEFAULT_PORT = 47120;
/** Where the phone app is published (ADR 0005 decision 2: GitHub Pages first). */
export const COMPANION_DEFAULT_APP_URL = 'https://noboishraque.github.io/triage';
/** A QR code changes this often, and each one works this long (Signal's 45 s and 90 s). */
export const PAIRING_ROTATE_MS = 45_000;
export const PAIRING_LIFETIME_MS = 90_000;
/** The QR dialog stops showing codes after this long ("Show again" restarts it). */
export const PAIRING_WINDOW_MS = 5 * 60_000;
/** The person at the laptop has this long to answer a phone. */
export const PAIRING_ANSWER_MS = 2 * 60_000;
/** A phone unused this long pairs again (WhatsApp's linked devices: 35 days). */
export const PHONE_EXPIRY_MS = 30 * 24 * 3600_000;

export const COMPANION_SETTINGS = {
	enabled: 'triage.companion.enabled',
	port: 'triage.companion.port',
	appUrl: 'triage.companion.appUrl',
	relay: 'triage.companion.relay',
	address: 'triage.companion.address',
	keepAwake: 'triage.companion.keepAwake',
} as const;

export const COMPANION_COMMANDS = {
	pair: 'triage.companion.pair',
	showOn: 'triage.companion.showOn',
	phones: 'triage.companion.phones',
	setPermission: 'triage.companion.setPermission',
	disconnect: 'triage.companion.disconnect',
	remove: 'triage.companion.remove',
	stop: 'triage.companion.stop',
	allowEditing: 'triage.companion.allowEditing',
} as const;

/** A certificate as the window stores it (base64url fields). */
export interface ICompanionCertificateJson {
	readonly der: string;
	readonly keyDer: string;
	readonly notBefore: number;
	readonly notAfter: number;
	readonly hash: string;
}

export interface ICompanionBrokerStart {
	/** The folder holding triage_companion.node. */
	readonly addonFolder: string;
	/** The laptop's static X25519 key, base64url; empty to make one. */
	readonly staticPrivate: string;
	readonly certificates: readonly ICompanionCertificateJson[];
	readonly port: number;
	/** Origins whose pages may connect on the LAN (the phone app's). */
	readonly origins: readonly string[];
	/** A LAN address to put in QR codes instead of the ones found. */
	readonly address?: string;
}

export interface ICompanionBrokerStarted {
	readonly port: number;
	readonly addresses: readonly string[];
	readonly staticPrivate: string;
	readonly laptopKey: string;
	readonly certificates: readonly ICompanionCertificateJson[];
}

/** A pairing QR code (and, with a relay, a typed code), as the dialog draws it. */
export interface ICompanionPairing {
	/** The pairing id, base64url. */
	readonly id: string;
	readonly link: string;
	/** QR modules per side, and one character per module ("1" dark). */
	readonly width: number;
	readonly modules: string;
	/** ABCD-EFGH, only with a relay (it meets the laptop there). */
	readonly code?: string;
	readonly codeMailbox?: string;
	/** Unix ms. */
	readonly expires: number;
}

/** An event from the broker: its JSON (kind, session, mode, ids in base64url …) and data. */
export type CompanionBrokerEvent = [json: string, data: VSBuffer];

export interface ICompanionBroker {
	readonly onDidEvent: Event<CompanionBrokerEvent>;
	start(options: ICompanionBrokerStart): Promise<ICompanionBrokerStarted>;
	stop(): Promise<void>;
	newPairing(view: string, appUrl: string, relay: string | undefined, withCode: boolean): Promise<ICompanionPairing>;
	removePairing(id: string): Promise<void>;
	consumePairing(id: string): Promise<void>;
	failPairing(id: string): Promise<number>;
	setPhones(phones: readonly { mailbox: string; key: string }[]): Promise<void>;
	setRelay(url: string | undefined, mailboxes: readonly string[]): Promise<void>;
	/** `droppable`: give up instead of waiting when the phone's queue is full (simulation frames). */
	send(session: number, data: VSBuffer, droppable: boolean): Promise<boolean>;
	close(session: number, refusal: string, text: string): Promise<void>;
	info(): Promise<{ port: number | undefined; addresses: string[]; certificateHashes: string[]; sessions: number }>;
}

/** A paired phone, as the laptop keeps it. */
export interface ICompanionPhone {
	readonly id: string;
	readonly name: string;
	/** The phone's static public key, base64url. */
	readonly key: string;
	/** Its relay mailbox and reconnect id, base64url. */
	readonly mailbox: string;
	/** The permission last chosen for it (what Show on proposes). */
	readonly permission: CompanionPermission;
	readonly paired: number;
	readonly lastSeen: number;
}

/** A phone connected now. */
export interface ICompanionConnection {
	readonly session: number;
	readonly phoneId: string | undefined;
	readonly name: string;
	readonly permission: CompanionPermission;
	readonly state: 'pending' | 'active';
	readonly route: 'lan' | 'relay';
	readonly view: string | undefined;
	readonly since: number;
	/** Edits this phone made in the session (the security review's list). */
	readonly edits: number;
}

/** The pairing dialog's state. */
export interface ICompanionPairingState {
	readonly view: string;
	readonly qr: ICompanionPairing | undefined;
	/** The dialog ran out of time: Show again. */
	readonly stopped: boolean;
	readonly error?: string;
	/** A phone answered: compare the six digits, then Allow or Deny. */
	readonly request?: { readonly session: number; readonly sas: string; readonly name: string; readonly route: 'lan' | 'relay' };
	/** Port and addresses phones try, for the dialog's small print. */
	readonly listening?: { readonly port: number; readonly addresses: readonly string[] };
}

export const ITriageCompanionService = createDecorator<ITriageCompanionService>('triageCompanionService');

export interface ITriageCompanionService {
	readonly _serviceBrand: undefined;
	readonly phones: readonly ICompanionPhone[];
	readonly connections: readonly ICompanionConnection[];
	readonly pairing: ICompanionPairingState | undefined;
	/** Phones, connections or the pairing dialog changed. */
	readonly onDidChange: Event<void>;
	/** Opens pairing for a tab ("board", "schematic", "3d", "sim"): QR codes until a phone answers. */
	startPairing(view: string): Promise<void>;
	/** Closes the pairing dialog. */
	stopPairing(): void;
	/** The person's answer to a phone that scanned the code. */
	answerPairing(answer: CompanionPermission | 'deny', name?: string): Promise<void>;
	/** Shows a tab on a paired phone with a permission (asked every time the laptop shares). */
	showOn(phoneId: string, view: string, permission: CompanionPermission): Promise<void>;
	setPermission(session: number, permission: CompanionPermission): Promise<void>;
	disconnect(session: number): Promise<void>;
	removePhone(phoneId: string): Promise<void>;
	/** Stops listening and closes every phone's session. */
	stopSharing(): Promise<void>;
}
