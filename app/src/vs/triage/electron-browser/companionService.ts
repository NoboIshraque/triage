/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The phone companion in the window (ROADMAP PC-2 to PC-6, ADR 0005, PLAN §4.16).
 *
 *  - Starts the companion broker (a utility process with the Rust server) when the
 *    user picks Show on phone, and later at startup while phones are paired and
 *    the companion setting is on. Nothing listens before.
 *  - Pairs phones: rotating QR codes, the six digits on both screens, Allow with
 *    View only or View and edit (asked every time the laptop shares), keys kept
 *    in secret storage, paired phones in the machine's storage, Remove.
 *  - Answers phones' requests with the window's own engine services, checking
 *    each against the session's permission (protocol.ts): phone edits land in the
 *    same engine documents and undo history as the tabs', and every view redraws.
 *  - Streams changes to phones: documents, cross-probes, the laptop's tab, 3D
 *    scenes and simulation frames (at most 30 a second, dropped when a phone lags).
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { basename, join } from '../../base/common/path.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { localize } from '../../nls.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../platform/notification/common/notification.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { ISecretStorageService } from '../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../workbench/services/statusbar/browser/statusbar.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { CadView } from '../browser/cad/cadView.js';
import { kicadFileFor, TriageViewInput } from '../browser/triageViewEditor.js';
import { ITriageCadEngineService } from '../common/cad/cadEngineService.js';
import { COMPANION_BROKER_CHANNEL, COMPANION_BROKER_MODULE, COMPANION_COMMANDS, COMPANION_DEFAULT_APP_URL, COMPANION_DEFAULT_PORT, COMPANION_FOLDER, COMPANION_SETTINGS, COMPANION_STATUS_ID, ICompanionBroker, ICompanionBrokerStarted, ICompanionCertificateJson, ICompanionConnection, ICompanionPairingState, ICompanionPhone, ITriageCompanionService, PAIRING_ANSWER_MS, PAIRING_ROTATE_MS, PAIRING_WINDOW_MS, PHONE_EXPIRY_MS } from '../common/companion/companionService.js';
import { COMPANION_PROTOCOL, COMPANION_PROTOCOL_MAX, COMPANION_PROTOCOL_MIN, CompanionEnvelope, CompanionHello, CompanionPermission, CompanionViewInfo, CompanionWelcome, decodeEnvelope, edaPermission, encodeEnvelope, PHONE_REQUESTS, permits } from '../common/companion/protocol.js';
import { base64UrlDecode } from '../common/companion/qr.js';
import { ITriageCrossProbeService } from '../common/eda/crossProbe.js';
import * as api from '../common/eda/engineApi.generated.js';
import { ITriageEdaEngineService } from '../common/eda/edaEngine.js';
import { decodeMessage, encodeMessage, Message } from '../common/eda/protobuf.js';
import { ITriageProjectService } from '../common/projectModel.js';
import { ITriageSimService } from '../common/sim/simService.js';
import { TriageViewKind } from '../common/triage.js';

const PHONES_KEY = 'triage.companion.phones';
const IDENTITY_KEY = 'triage.companion.identity';
const FRAME_INTERVAL_MS = 33;
const VIEWS: readonly CompanionViewInfo['id'][] = ['board', 'schematic', '3d', 'sim'];

interface Identity {
	staticPrivate: string;
	certificates: ICompanionCertificateJson[];
}

interface Connection {
	readonly session: number;
	phoneId: string | undefined;
	name: string;
	permission: CompanionPermission;
	state: 'pending' | 'active';
	readonly route: 'lan' | 'relay';
	view: string | undefined;
	readonly since: number;
	edits: number;
	/** A pairing in progress: its id, and the phone's key. */
	pairingId?: string;
	phoneKey?: string;
	mode: 'pair' | 'reconnect' | 'code';
	/** Engine documents this phone opened views of. */
	readonly documents: Set<number>;
	follow: boolean;
	lastFrame: number;
	answerTimer?: ReturnType<typeof setTimeout>;
}

/** Rejects after `ms` with `message`. */
function timeout(ms: number, message: string): Promise<never> {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function sanitizeName(name: unknown, fallback: string): string {
	const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
	return text || fallback;
}

export class TriageCompanionService extends Disposable implements ITriageCompanionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _phones: ICompanionPhone[] = [];
	private readonly sessions = new Map<number, Connection>();
	private _pairing: ICompanionPairingState | undefined;
	private pairingIds: string[] = [];
	private codeMailboxes: string[] = [];
	private pairingTimer: ReturnType<typeof setTimeout> | undefined;
	private pairingStarted = 0;
	/** Show on a paired phone that isn't connected: what to give it when it comes. */
	private readonly showOnPending = new Map<string, { view: string; permission: CompanionPermission }>();

	private broker: Promise<ICompanionBroker> | undefined;
	private started: ICompanionBrokerStarted | undefined;
	private readonly worker = this._register(new MutableDisposable());
	private readonly brokerListeners = this._register(new DisposableStore());
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private keepAwake: number | undefined;
	private frameTimer: ReturnType<typeof setTimeout> | undefined;
	private sceneTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly cadListeners = this._register(new DisposableStore());

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly workerService: IUtilityProcessWorkerWorkbenchService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IProductService private readonly productService: IProductService,
		@IEditorService private readonly editorService: IEditorService,
		@ITriageEdaEngineService private readonly eda: ITriageEdaEngineService,
		@ITriageCadEngineService private readonly cad: ITriageCadEngineService,
		@ITriageSimService private readonly sim: ITriageSimService,
		@ITriageProjectService private readonly projectService: ITriageProjectService,
		@ITriageCrossProbeService private readonly crossProbe: ITriageCrossProbeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._phones = this.loadPhones();
		this._register(this.eda.onDidChangeDocument(change => {
			const from = change.origin?.startsWith('phone:') ? Number(change.origin.slice(6)) : undefined;
			for (const connection of this.active()) {
				if (connection.session !== from && connection.documents.has(change.document)) {
					this.event(connection, 'event:document', { document: change.document, command: change.command });
				}
			}
		}));
		this._register(this.eda.onDidRestart(() => {
			for (const connection of this.active()) {
				connection.documents.clear();
				this.event(connection, 'event:reload', {});
			}
		}));
		this._register(this.crossProbe.onDidProbe(probe => {
			if (probe.source === 'phone') {
				return;
			}
			for (const connection of this.active()) {
				this.event(connection, 'event:select', { source: probe.source, references: probe.references, net: probe.net ?? '' });
			}
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const view = this.laptopView();
			if (view) {
				for (const connection of this.active()) {
					this.event(connection, 'event:laptop', { view });
				}
			}
		}));
		this._register(this.sim.onDidChangeState(state => {
			for (const connection of this.active()) {
				this.event(connection, 'event:sim.state', { state });
			}
		}));
		this._register(this.sim.onDidFrame(() => this.scheduleFrame()));
		this._register(this.projectService.onDidChangeState(() => {
			this.maybeStart();
			for (const connection of this.active()) {
				this.event(connection, 'event:views', { views: this.views() });
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(COMPANION_SETTINGS.relay)) {
				void this.updateRelay();
			}
		}));
		this.watchCadViews();
		this.maybeStart();
	}

	// ---- State -------------------------------------------------------------------------------

	get phones(): readonly ICompanionPhone[] {
		return this._phones;
	}

	get connections(): readonly ICompanionConnection[] {
		return [...this.sessions.values()].map(c => ({
			session: c.session, phoneId: c.phoneId, name: c.name, permission: c.permission, state: c.state,
			route: c.route, view: c.view, since: c.since, edits: c.edits,
		}));
	}

	get pairing(): ICompanionPairingState | undefined {
		return this._pairing;
	}

	private active(): Connection[] {
		return [...this.sessions.values()].filter(c => c.state === 'active');
	}

	private changed(): void {
		this.updateStatus();
		this.updateKeepAwake();
		this._onDidChange.fire();
	}

	private loadPhones(): ICompanionPhone[] {
		try {
			const phones = JSON.parse(this.storageService.get(PHONES_KEY, StorageScope.APPLICATION, '[]')) as ICompanionPhone[];
			const now = Date.now();
			// A phone unused for 30 days pairs again (PLAN §4.16).
			return phones.filter(p => typeof p.key === 'string' && typeof p.mailbox === 'string' && now - (p.lastSeen || p.paired) < PHONE_EXPIRY_MS);
		} catch {
			return [];
		}
	}

	private savePhones(): void {
		this.storageService.store(PHONES_KEY, JSON.stringify(this._phones), StorageScope.APPLICATION, StorageTarget.MACHINE);
		void this.broker?.then(broker => broker.setPhones(this._phones.map(p => ({ mailbox: p.mailbox, key: p.key }))));
		void this.updateRelay();
	}

	private updatePhone(id: string, change: Partial<ICompanionPhone>): void {
		this._phones = this._phones.map(p => p.id === id ? { ...p, ...change } : p);
		this.savePhones();
	}

	// ---- The broker --------------------------------------------------------------------------

	/** Listens at startup when phones are paired, the setting is on and a project is open. */
	private maybeStart(): void {
		if (!this.broker && this._phones.length > 0 && this.projectService.state.kind === 'project'
			&& this.configurationService.getValue<boolean>(COMPANION_SETTINGS.enabled)) {
			void this.getBroker().catch(error => this.logService.warn('[triage] companion: not listening', error));
		}
	}

	private getBroker(): Promise<ICompanionBroker> {
		if (!this.broker) {
			this.broker = this.createBroker();
			this.broker.catch(() => {
				this.broker = undefined;
				this.started = undefined;
				this.changed();
			});
		}
		return this.broker;
	}

	private async createBroker(): Promise<ICompanionBroker> {
		this.logService.info('[triage] companion: starting the broker');
		const worker = await this.workerService.createWorker({ moduleId: COMPANION_BROKER_MODULE, type: 'triageCompanion', name: 'triage-companion-broker' });
		this.worker.value = worker;
		let terminated: ((reason: string) => void) | undefined;
		const died = new Promise<never>((_, reject) => { terminated = reason => reject(new Error(reason)); });
		died.catch(() => undefined);
		void worker.onDidTerminate.then(({ reason }) => {
			const why = localize('triage.companion.brokerExited', "the companion's process stopped (code {0}{1})", String(reason?.code ?? '?'), reason?.signal ? `, ${reason.signal}` : '');
			this.logService.warn(`[triage] companion: ${why}`);
			terminated?.(why);
			if (this.worker.value === worker) {
				this.broker = undefined;
				this.started = undefined;
				for (const connection of [...this.sessions.values()]) {
					this.dropConnection(connection.session, 'the companion stopped');
				}
				this.changed();
			}
		});
		const broker = ProxyChannel.toService<ICompanionBroker>(worker.client.getChannel(COMPANION_BROKER_CHANNEL));
		this.brokerListeners.clear();
		this.brokerListeners.add(broker.onDidEvent(([json, data]) => void this.onBrokerEvent(JSON.parse(json), data.buffer)));
		const identity = await this.loadIdentity();
		this.logService.info(`[triage] companion: keys ${identity ? 'loaded' : 'not stored yet'}`);
		const appUrl = this.appUrl();
		let origin = '';
		try {
			origin = new URL(appUrl).origin;
		} catch {
			// no origin check for an odd URL
		}
		const starting = broker.start({
			addonFolder: join(this.environmentService.appRoot, 'engines', COMPANION_FOLDER),
			staticPrivate: identity?.staticPrivate ?? '',
			certificates: identity?.certificates ?? [],
			port: this.configurationService.getValue<number>(COMPANION_SETTINGS.port) || COMPANION_DEFAULT_PORT,
			// The app's own origin; tests serve it from localhost.
			origins: origin ? [origin] : [],
			address: this.configurationService.getValue<string>(COMPANION_SETTINGS.address) || undefined,
		});
		// A process that dies leaves the call unanswered: race it with the exit and a timeout.
		const started = await Promise.race([starting, died, timeout(30_000, localize('triage.companion.startTimeout', "the companion's process didn't answer in 30 s"))]);
		this.started = started;
		await this.saveIdentity({ staticPrivate: started.staticPrivate, certificates: [...started.certificates] });
		await broker.setPhones(this._phones.map(p => ({ mailbox: p.mailbox, key: p.key })));
		this.logService.info(`[triage] companion listening on UDP ${started.port} (${started.addresses.join(', ') || 'no LAN address'})`);
		this.changed();
		setTimeout(() => void this.updateRelay(), 0);
		return broker;
	}

	private async loadIdentity(): Promise<Identity | undefined> {
		try {
			// Secret storage can stall where no OS keyring answers (Linux without one).
			const text = await Promise.race([this.secretStorage.get(IDENTITY_KEY), timeout(5000, 'secret storage did not answer')]);
			return text ? JSON.parse(text) as Identity : undefined;
		} catch (error) {
			this.logService.warn('[triage] companion: no stored keys', error);
			return undefined;
		}
	}

	private async saveIdentity(identity: Identity): Promise<void> {
		try {
			await Promise.race([this.secretStorage.set(IDENTITY_KEY, JSON.stringify(identity)), timeout(5000, 'secret storage did not answer')]);
		} catch (error) {
			this.logService.warn('[triage] companion: the keys were not stored; phones will pair again after a restart', error);
		}
	}

	private appUrl(): string {
		return (this.configurationService.getValue<string>(COMPANION_SETTINGS.appUrl) || COMPANION_DEFAULT_APP_URL).replace(/\/+$/, '');
	}

	private relayUrl(): string | undefined {
		const relay = this.configurationService.getValue<string>(COMPANION_SETTINGS.relay)?.trim();
		return relay && /^wss?:\/\//.test(relay) ? relay.replace(/\/+$/, '') : undefined;
	}

	/** One relay connection per open pairing, typed code and paired phone. */
	private async updateRelay(): Promise<void> {
		if (!this.broker || !this.started) {
			return;
		}
		const relay = this.relayUrl();
		const mailboxes = relay ? [...this.pairingIds, ...this.codeMailboxes, ...this._phones.map(p => p.mailbox)] : [];
		await (await this.broker).setRelay(relay, mailboxes);
	}

	// ---- Pairing -----------------------------------------------------------------------------

	async startPairing(view: string): Promise<void> {
		this._pairing = { view, qr: undefined, stopped: false };
		this.pairingStarted = Date.now();
		this.changed();
		try {
			await this.getBroker();
			await this.rotate();
		} catch (error) {
			this._pairing = { view, qr: undefined, stopped: true, error: localize('triage.companion.startFailed', "Phones can't reach this laptop: {0}", error instanceof Error ? error.message : String(error)) };
			this.changed();
		}
	}

	private async rotate(): Promise<void> {
		clearTimeout(this.pairingTimer);
		const pairing = this._pairing;
		if (!pairing || pairing.request) {
			return;
		}
		const broker = await this.getBroker();
		if (Date.now() - this.pairingStarted > PAIRING_WINDOW_MS) {
			this._pairing = { ...pairing, qr: undefined, stopped: true };
			this.changed();
			return;
		}
		const relay = this.relayUrl();
		const qr = await broker.newPairing(pairing.view, this.appUrl(), relay, true);
		// Keep the previous code for a while (a phone may be answering it), then let it expire.
		this.pairingIds = [qr.id, ...this.pairingIds].slice(0, 2);
		this.codeMailboxes = qr.codeMailbox ? [qr.codeMailbox, ...this.codeMailboxes].slice(0, 2) : [];
		if (this._pairing === pairing || this._pairing?.view === pairing.view) {
			const info = await broker.info();
			this._pairing = { ...this._pairing ?? pairing, qr, stopped: false, listening: { port: info.port ?? 0, addresses: info.addresses } };
			this.changed();
		}
		void this.updateRelay();
		this.pairingTimer = setTimeout(() => void this.rotate().catch(error => this.logService.warn('[triage] companion: QR rotation', error)), PAIRING_ROTATE_MS);
	}

	stopPairing(): void {
		clearTimeout(this.pairingTimer);
		const request = this._pairing?.request;
		if (request) {
			void this.answerPairing('deny');
		}
		void this.broker?.then(broker => Promise.all(this.pairingIds.map(id => broker.removePairing(id))));
		this.pairingIds = [];
		this.codeMailboxes = [];
		this._pairing = undefined;
		void this.updateRelay();
		this.changed();
	}

	async answerPairing(answer: CompanionPermission | 'deny', name?: string): Promise<void> {
		const pairing = this._pairing;
		const request = pairing?.request;
		const connection = request ? this.sessions.get(request.session) : undefined;
		if (!pairing || !request || !connection) {
			return;
		}
		clearTimeout(connection.answerTimer);
		const broker = await this.getBroker();
		this._pairing = { ...pairing, request: undefined };
		if (answer === 'deny') {
			if (connection.pairingId) {
				await broker.failPairing(connection.pairingId);
			}
			await broker.close(connection.session, 'denied', '');
			this.dropConnection(connection.session, 'denied');
			void this.rotate();
			this.changed();
			return;
		}
		if (connection.pairingId) {
			await broker.consumePairing(connection.pairingId);
		}
		const key = connection.phoneKey;
		if (!key) {
			await broker.close(connection.session, 'protocol', 'no phone key');
			this.dropConnection(connection.session, 'no phone key');
			return;
		}
		const phone: ICompanionPhone = {
			id: `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			name: sanitizeName(name, connection.name),
			key,
			mailbox: this.randomMailbox(),
			permission: answer,
			paired: Date.now(),
			lastSeen: Date.now(),
		};
		// One entry per phone key: pairing again replaces the old one.
		this._phones = [...this._phones.filter(p => p.key !== key), phone];
		this.savePhones();
		connection.phoneId = phone.id;
		connection.name = phone.name;
		connection.permission = answer;
		this.stopPairing();
		await this.welcome(connection, pairing.view);
		this.notificationService.info(answer === 'edit'
			? localize('triage.companion.pairedEdit', "{0} is paired and shows the {1} tab (view and edit).", phone.name, pairing.view)
			: localize('triage.companion.pairedView', "{0} is paired and shows the {1} tab (view only).", phone.name, pairing.view));
	}

	private randomMailbox(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		let binary = '';
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	// ---- Sessions ----------------------------------------------------------------------------

	private async onBrokerEvent(event: { kind: string; session?: number; mode?: 'pair' | 'reconnect' | 'code'; id?: string; phoneKey?: string; sas?: string; route?: 'lan' | 'relay'; reason?: string; attempts?: number; connected?: boolean; certificates?: ICompanionCertificateJson[] }, data: Uint8Array): Promise<void> {
		switch (event.kind) {
			case 'handshake':
				await this.onHandshake(event as Required<typeof event>, data);
				break;
			case 'message': {
				const connection = event.session !== undefined ? this.sessions.get(event.session) : undefined;
				if (connection) {
					await this.onMessage(connection, data);
				}
				break;
			}
			case 'closed':
				if (event.session !== undefined) {
					this.dropConnection(event.session, event.reason ?? 'closed');
				}
				break;
			case 'failed':
				this.logService.info(`[triage] companion: a phone failed a ${event.mode} handshake (${event.reason}, attempt ${event.attempts})`);
				if ((event.attempts ?? 0) >= 5 && this._pairing && event.id && this.pairingIds.includes(event.id)) {
					void this.rotate();
				}
				break;
			case 'certificates':
				if (this.started && event.certificates) {
					const identity = await this.loadIdentity();
					await this.saveIdentity({ staticPrivate: identity?.staticPrivate ?? this.started.staticPrivate, certificates: event.certificates });
					const hashes = event.certificates.map(c => c.hash);
					for (const connection of this.active()) {
						this.event(connection, 'event:certificates', { certificateHashes: hashes });
					}
				}
				break;
			case 'relay':
				if (!event.connected) {
					this.logService.trace(`[triage] companion relay: ${event.reason ?? 'disconnected'}`);
				}
				break;
		}
	}

	private async onHandshake(event: { session: number; mode: 'pair' | 'reconnect' | 'code'; id: string; phoneKey: string; sas: string; route: 'lan' | 'relay' }, data: Uint8Array): Promise<void> {
		const broker = await this.getBroker();
		let hello: CompanionHello;
		try {
			const envelope = decodeEnvelope(data);
			hello = JSON.parse(envelope.json) as CompanionHello;
			if (envelope.kind !== 'hello' || typeof hello.protocol !== 'number') {
				throw new Error('no hello');
			}
		} catch {
			await broker.close(event.session, 'protocol', 'expected a hello');
			return;
		}
		if (hello.protocol < COMPANION_PROTOCOL_MIN || hello.protocol > COMPANION_PROTOCOL_MAX) {
			await broker.close(event.session, 'incompatible', `the phone app speaks protocol ${hello.protocol}; this Triage speaks ${COMPANION_PROTOCOL_MIN}–${COMPANION_PROTOCOL_MAX}`);
			return;
		}
		const name = sanitizeName(hello.name, localize('triage.companion.aPhone', "A phone"));
		const connection: Connection = {
			session: event.session, phoneId: undefined, name, permission: 'view', state: 'pending', route: event.route,
			view: undefined, since: Date.now(), edits: 0, mode: event.mode, documents: new Set(), follow: false, lastFrame: 0,
		};
		if (event.mode === 'reconnect') {
			const phone = this._phones.find(p => p.mailbox === event.id && p.key === event.phoneKey);
			if (!phone) {
				await broker.close(event.session, 'not-paired', '');
				return;
			}
			const shown = this.showOnPending.get(phone.id);
			this.showOnPending.delete(phone.id);
			connection.phoneId = phone.id;
			connection.name = phone.name;
			// A phone that comes back by itself is view only until the laptop allows more.
			connection.permission = shown?.permission ?? 'view';
			this.sessions.set(event.session, connection);
			this.updatePhone(phone.id, { lastSeen: Date.now() });
			await this.welcome(connection, shown?.view ?? this.laptopView() ?? 'board');
			if (!shown) {
				this.notificationService.prompt(Severity.Info,
					localize('triage.companion.reconnected', "{0} connected (view only).", phone.name),
					[
						{ label: localize('triage.companion.allowEditing', "Allow Editing"), run: () => void this.setPermission(event.session, 'edit') },
						{ label: localize('triage.companion.disconnectButton', "Disconnect"), run: () => void this.disconnect(event.session) },
					]);
			}
			return;
		}
		// Pair or typed code: only while the dialog shows this code, one phone at a time.
		const known = event.mode === 'pair' ? this.pairingIds.includes(event.id) : this.codeMailboxes.includes(event.id);
		if (!this._pairing || !known) {
			await broker.close(event.session, 'expired', '');
			return;
		}
		if (this._pairing.request) {
			await broker.close(event.session, 'busy', '');
			return;
		}
		let phoneKey = event.phoneKey;
		if (event.mode === 'code') {
			// NNpsk0 carries no static key: the phone sends it inside the sealed hello.
			try {
				if (!hello.phoneKey || base64UrlDecode(hello.phoneKey).byteLength !== 32) {
					throw new Error();
				}
				phoneKey = hello.phoneKey;
			} catch {
				await broker.close(event.session, 'protocol', 'a typed-code pairing needs the phone key');
				return;
			}
		}
		connection.pairingId = event.id;
		connection.phoneKey = phoneKey;
		connection.answerTimer = setTimeout(() => {
			if (this._pairing?.request?.session === event.session) {
				void this.answerPairing('deny');
			}
		}, PAIRING_ANSWER_MS);
		this.sessions.set(event.session, connection);
		clearTimeout(this.pairingTimer);
		this._pairing = { ...this._pairing, request: { session: event.session, sas: event.sas, name, route: event.route } };
		this.send(connection, { kind: 'event:pending', json: JSON.stringify({ message: 'Compare the six digits with the laptop, then wait for Allow.' }) });
		this.changed();
	}

	private async welcome(connection: Connection, view: string): Promise<void> {
		const phone = this._phones.find(p => p.id === connection.phoneId);
		const info = await (await this.getBroker()).info();
		connection.state = 'active';
		connection.view = view;
		const state = this.projectService.state;
		const welcome: CompanionWelcome = {
			permission: connection.permission,
			laptop: localize('triage.companion.laptopName', "Triage on this laptop"),
			project: state.kind === 'project' ? state.project.name : '',
			views: this.views(),
			view,
			mailbox: phone?.mailbox ?? '',
			laptopKey: this.started?.laptopKey ?? '',
			certificateHashes: info.certificateHashes,
			addresses: info.addresses,
			relay: this.relayUrl(),
			protocol: COMPANION_PROTOCOL,
			triageVersion: this.productService.version,
		};
		this.send(connection, { kind: 'event:welcome', json: JSON.stringify(welcome) });
		this.changed();
	}

	private dropConnection(session: number, reason: string): void {
		const connection = this.sessions.get(session);
		if (!connection) {
			return;
		}
		clearTimeout(connection.answerTimer);
		this.sessions.delete(session);
		if (this._pairing?.request?.session === session) {
			this._pairing = { ...this._pairing, request: undefined };
			void this.rotate();
		}
		if (connection.phoneId) {
			this.updatePhone(connection.phoneId, { lastSeen: Date.now() });
		}
		this.logService.info(`[triage] companion: ${connection.name} left (${reason}); ${connection.edits} edit(s) this session`);
		this.changed();
	}

	async showOn(phoneId: string, view: string, permission: CompanionPermission): Promise<void> {
		const phone = this._phones.find(p => p.id === phoneId);
		if (!phone) {
			return;
		}
		this.updatePhone(phoneId, { permission });
		const connection = this.active().find(c => c.phoneId === phoneId);
		if (connection) {
			await this.setPermission(connection.session, permission);
			connection.view = view;
			this.event(connection, 'event:show', { view });
			this.changed();
			return;
		}
		this.showOnPending.set(phoneId, { view, permission });
		await this.getBroker();
		this.notificationService.info(localize('triage.companion.openApp', "Open Triage on {0}: it connects by itself and shows the {1} tab.", phone.name, view));
	}

	async setPermission(session: number, permission: CompanionPermission): Promise<void> {
		const connection = this.sessions.get(session);
		if (!connection || connection.state !== 'active') {
			return;
		}
		connection.permission = permission;
		this.event(connection, 'event:permission', { permission });
		this.changed();
	}

	async disconnect(session: number): Promise<void> {
		await (await this.getBroker()).close(session, 'closed', 'the laptop disconnected this phone');
		this.dropConnection(session, 'disconnected');
	}

	async removePhone(phoneId: string): Promise<void> {
		const sessions = [...this.sessions.values()].filter(c => c.phoneId === phoneId);
		this._phones = this._phones.filter(p => p.id !== phoneId);
		this.savePhones();
		for (const connection of sessions) {
			await (await this.getBroker()).close(connection.session, 'not-paired', 'the laptop removed this phone');
			this.dropConnection(connection.session, 'removed');
		}
		this.changed();
	}

	async stopSharing(): Promise<void> {
		this.stopPairing();
		const broker = this.broker;
		this.broker = undefined;
		this.started = undefined;
		if (broker) {
			await (await broker).stop().catch(() => undefined);
		}
		for (const session of [...this.sessions.keys()]) {
			this.dropConnection(session, 'stopped sharing');
		}
		this.worker.clear();
		this.changed();
	}

	// ---- Messages ----------------------------------------------------------------------------

	private send(connection: Connection, envelope: Partial<CompanionEnvelope> & { kind: string }, droppable = false): void {
		void this.broker?.then(broker => broker.send(connection.session, VSBuffer.wrap(encodeEnvelope(envelope)), droppable));
	}

	private event(connection: Connection, kind: string, body: unknown, blobs: readonly Uint8Array[] = [], droppable = false): void {
		this.send(connection, { kind, json: JSON.stringify(body), blobs }, droppable);
	}

	private reply(connection: Connection, request: CompanionEnvelope, body: unknown, blobs: readonly Uint8Array[] = []): void {
		this.send(connection, { replyTo: request.id, kind: request.kind, json: body === undefined ? '' : JSON.stringify(body), blobs });
	}

	private refuse(connection: Connection, request: CompanionEnvelope, error: string): void {
		this.send(connection, { replyTo: request.id, kind: request.kind, error });
	}

	private async onMessage(connection: Connection, data: Uint8Array): Promise<void> {
		let request: CompanionEnvelope;
		try {
			request = decodeEnvelope(data);
		} catch {
			await (await this.getBroker()).close(connection.session, 'protocol', 'not an envelope');
			return;
		}
		if (connection.state !== 'active') {
			// Waiting for Allow: nothing but goodbye.
			if (request.kind !== 'ping' && request.kind !== 'bye') {
				this.refuse(connection, request, 'Waiting for Allow on the laptop.');
			}
			return;
		}
		const needed = PHONE_REQUESTS[request.kind];
		if (!needed) {
			this.refuse(connection, request, `Unknown request ${request.kind}.`);
			return;
		}
		if (needed !== 'eda' && !permits(connection.permission, needed)) {
			this.refuse(connection, request, 'This phone may only view: ask on the laptop for edit permission.');
			return;
		}
		try {
			const body = request.json ? JSON.parse(request.json) : {};
			if (typeof body !== 'object' || body === null) {
				throw new Error('the body must be an object');
			}
			await this.handle(connection, request, body as Record<string, unknown>);
		} catch (error) {
			this.refuse(connection, request, error instanceof Error ? error.message : String(error));
		}
	}

	private async handle(connection: Connection, request: CompanionEnvelope, body: Record<string, unknown>): Promise<void> {
		const text = (key: string, max = 200): string => {
			const value = body[key];
			if (typeof value !== 'string' || value.length > max) {
				throw new Error(`${key} must be a string`);
			}
			return value;
		};
		const number = (key: string, min: number, max: number): number => {
			const value = body[key];
			if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
				throw new Error(`${key} must be a number from ${min} to ${max}`);
			}
			return value;
		};
		switch (request.kind) {
			case 'ping':
				if (request.id) {
					this.reply(connection, request, { t: Date.now() });
				}
				return;
			case 'bye':
				return;
			case 'unlink':
				this.reply(connection, request, {});
				if (connection.phoneId) {
					this.notificationService.info(localize('triage.companion.unlinked', "{0} unlinked itself from this laptop.", connection.name));
					await this.removePhone(connection.phoneId);
				}
				return;
			case 'views':
				this.reply(connection, request, { views: this.views(), view: this.laptopView() });
				return;
			case 'follow':
				connection.follow = body['on'] === true;
				this.reply(connection, request, { on: connection.follow, view: this.laptopView() });
				return;
			case 'view.open':
				return this.openView(connection, request, text('view', 20));
			case 'eda':
				return this.edaRequest(connection, request);
			case 'select': {
				const references = Array.isArray(body['references']) ? (body['references'] as unknown[]).filter((r): r is string => typeof r === 'string' && r.length <= 40).slice(0, 50) : [];
				const net = typeof body['net'] === 'string' ? (body['net'] as string).slice(0, 200) : undefined;
				this.crossProbe.probe({ source: 'phone', references, net: net || undefined });
				this.reply(connection, request, {});
				return;
			}
			case 'cad.scene':
				return this.cadScene(connection, request);
			case 'cad.properties': {
				const { result } = await this.cad.call<unknown>('object.properties', { doc: text('doc'), object: text('object') });
				this.reply(connection, request, result);
				return;
			}
			case 'cad.setProperty': {
				const view = [...CadView.instances][0];
				if (!view) {
					throw new Error('Open the 3D tab on the laptop first.');
				}
				const value = body['value'];
				if (!['number', 'string', 'boolean'].includes(typeof value)) {
					throw new Error('value must be a number, text or yes/no');
				}
				const doc = text('doc');
				const object = text('object');
				const property = text('property', 100);
				await view.setProperty(doc, object, property, value);
				this.noteEdit(connection, `3D ${doc}/${object}.${property} = ${JSON.stringify(value)}`);
				this.reply(connection, request, {});
				return;
			}
			case 'sim.load': {
				const loaded = await this.sim.load();
				this.reply(connection, request, { scopes: loaded.scopes, scenarios: loaded.scenarios.map(f => basename(f)), mujoco: loaded.mujoco });
				return;
			}
			case 'sim.state':
				this.reply(connection, request, { state: this.sim.state, frame: this.sim.lastFrame, transforms: this.transforms() });
				return;
			case 'sim.prepare':
				this.reply(connection, request, { state: await this.sim.prepare(text('scope')) });
				this.noteEdit(connection, `sim prepare ${body['scope']}`);
				return;
			case 'sim.run':
				await this.sim.run(number('speed', 0, 1000));
				this.reply(connection, request, {});
				return;
			case 'sim.pause':
				await this.sim.pause();
				this.reply(connection, request, {});
				return;
			case 'sim.step':
				await this.sim.step(number('seconds', 0.0001, 10));
				this.reply(connection, request, {});
				return;
			case 'sim.stop':
				await this.sim.stop();
				this.reply(connection, request, {});
				return;
			case 'sim.setSpeed':
				await this.sim.setSpeed(number('speed', 0, 1000));
				this.reply(connection, request, {});
				return;
			case 'sim.input':
				await this.sim.input(text('control'), number('value', -1e9, 1e9));
				this.reply(connection, request, {});
				return;
			case 'sim.release':
				await this.sim.release(text('control'), number('value', -1e9, 1e9));
				this.reply(connection, request, {});
				return;
			case 'sim.sendSerial':
				await this.sim.sendSerial(text('text', 1000));
				this.reply(connection, request, {});
				return;
			case 'sim.runScenarios': {
				const loaded = await this.sim.load();
				const names = Array.isArray(body['names']) ? new Set((body['names'] as unknown[]).filter((n): n is string => typeof n === 'string')) : undefined;
				const files = loaded.scenarios.filter(f => !names || names.has(basename(f)));
				const results = await this.sim.runScenarios(files);
				this.noteEdit(connection, `ran ${files.length} scenario(s)`);
				this.reply(connection, request, { results });
				return;
			}
		}
		throw new Error(`Unknown request ${request.kind}.`);
	}

	private noteEdit(connection: Connection, what: string): void {
		connection.edits++;
		this.logService.info(`[triage] companion: ${connection.name} (${connection.permission}) — ${what}`);
		this.changed();
	}

	// ---- Views -------------------------------------------------------------------------------

	private views(): CompanionViewInfo[] {
		const state = this.projectService.state;
		const kicad = kicadFileFor(state, TriageViewKind.Board);
		const has3d = CadView.instances.size > 0;
		return VIEWS.map(id => {
			switch (id) {
				case 'board': return { id, label: localize('triage.companion.board', "Board"), available: !!kicad };
				case 'schematic': return { id, label: localize('triage.companion.schematic', "Schematic"), available: !!kicad };
				case '3d': return { id, label: localize('triage.companion.3d', "3D"), available: has3d, detail: has3d ? undefined : localize('triage.companion.open3d', "Open the 3D tab on the laptop") };
				default: return { id, label: localize('triage.companion.sim', "Sim"), available: state.kind === 'project' };
			}
		});
	}

	/** The Triage tab the laptop shows (Follow laptop). */
	private laptopView(): string | undefined {
		const input = this.editorService.activeEditor;
		if (input instanceof TriageViewInput) {
			const kind = input.view.kind;
			return VIEWS.includes(kind as CompanionViewInfo['id']) ? kind : undefined;
		}
		return undefined;
	}

	private async openView(connection: Connection, request: CompanionEnvelope, view: string): Promise<void> {
		connection.view = view;
		this.changed();
		if (view !== 'board' && view !== 'schematic') {
			this.reply(connection, request, { view });
			return;
		}
		const path = kicadFileFor(this.projectService.state, view === 'board' ? TriageViewKind.Board : TriageViewKind.Schematic);
		if (!path) {
			throw new Error('This project has no KiCad files.');
		}
		// The tab's own document, so phone edits share its undo history; else a new one.
		let document = this.eda.documentFor(path);
		let info = document ? this.eda.documentInfo(document) : undefined;
		if (!document || !info) {
			const opened = await this.eda.call('openDocument', { path }, `phone:${connection.session}`);
			document = opened.response.document.document as number;
			info = opened.response.document as Message;
		}
		connection.documents.add(document);
		this.reply(connection, request, { view, document, file: basename(path) }, [encodeMessage(api.DocumentInfo, info)]);
	}

	private async edaRequest(connection: Connection, request: CompanionEnvelope): Promise<void> {
		const bytes = request.blobs[0];
		if (!bytes) {
			throw new Error('an EDA request goes in the first blob');
		}
		const message = decodeMessage(api.Request, bytes);
		const needed = edaPermission(message);
		if (!needed) {
			throw new Error('A phone can\'t send that to the KiCad engine.');
		}
		if (!permits(connection.permission, needed)) {
			throw new Error('This phone may only view: ask on the laptop for edit permission.');
		}
		const command = Object.keys(message).find(key => key !== 'id' && message[key] !== undefined) ?? '';
		const body: Message = message[command];
		const document = Number(command === 'edit' ? body['document'] : body['document'] ?? 0);
		if (command !== 'getVersion' && !connection.documents.has(document)) {
			throw new Error('Open the view first.');
		}
		const result = await this.eda.call(command, body, `phone:${connection.session}`);
		if (needed === 'edit') {
			this.noteEdit(connection, `${command} on ${basename(this.edaPath(document) ?? '')}${command === 'edit' ? ` (${Object.keys(body).filter(k => k !== 'document' && body[k] !== undefined).join()})` : ''}`);
		}
		this.reply(connection, request, {}, [encodeMessage(api.Response, result.response), ...result.chunks]);
	}

	private edaPath(document: number): string | undefined {
		const info = this.eda.documentInfo(document);
		return info?.['path'] as string | undefined;
	}

	// ---- 3D ----------------------------------------------------------------------------------

	private watchCadViews(): void {
		// The 3D tab may open after a phone connected: check for new ones now and then.
		const attach = () => {
			this.cadListeners.clear();
			for (const view of CadView.instances) {
				this.cadListeners.add(view.onDidChangeScene(() => this.scheduleScene()));
			}
		};
		let count = -1;
		const timer = setInterval(() => {
			if (CadView.instances.size !== count) {
				count = CadView.instances.size;
				attach();
				for (const connection of this.active()) {
					this.event(connection, 'event:views', { views: this.views() });
				}
			}
		}, 1000);
		this._register({ dispose: () => clearInterval(timer) });
	}

	private scheduleScene(): void {
		clearTimeout(this.sceneTimer);
		this.sceneTimer = setTimeout(() => {
			for (const connection of this.active()) {
				if (connection.view === '3d') {
					this.event(connection, 'event:cad.scene', {});
				}
			}
		}, 250);
	}

	private async cadScene(connection: Connection, request: CompanionEnvelope): Promise<void> {
		const view = [...CadView.instances][0];
		if (!view) {
			this.reply(connection, request, { documents: [], objects: [], problems: [], missing: true });
			return;
		}
		const snapshot = view.snapshot();
		const blobs: Uint8Array[] = [];
		const bytes = (array: Float32Array | Uint32Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		const objects = snapshot.objects.map(o => {
			const first = blobs.length;
			blobs.push(bytes(o.mesh.positions), bytes(o.mesh.indices), bytes(o.mesh.faceStart), bytes(o.mesh.edgeStart), bytes(o.mesh.edgePoints));
			return {
				key: o.key, blob: first, colour: o.colour, visible: o.visible, problem: o.problem,
				highlightFaces: o.highlightFaces ? [...o.highlightFaces] : undefined,
				model: o.model ? Array.from(o.model) : undefined, emissive: o.emissive,
			};
		});
		this.reply(connection, request, { documents: snapshot.documents, objects, problems: snapshot.problems }, blobs);
	}

	private transforms(): { key: string; model?: number[]; emissive?: readonly number[] }[] {
		return [...CadView.instances][0]?.transforms() ?? [];
	}

	// ---- Simulation frames -------------------------------------------------------------------

	private scheduleFrame(): void {
		if (this.frameTimer || this.active().length === 0) {
			return;
		}
		this.frameTimer = setTimeout(() => {
			this.frameTimer = undefined;
			const frame = this.sim.lastFrame;
			if (!frame) {
				return;
			}
			const transforms = this.transforms();
			for (const connection of this.active()) {
				// State at up to 30 Hz; dropped (not queued) when this phone lags behind.
				this.event(connection, 'event:sim.frame', { frame, transforms }, [], true);
			}
		}, FRAME_INTERVAL_MS);
	}

	// ---- Status bar and keep-awake -------------------------------------------------------------

	private updateStatus(): void {
		const connections = this.connections;
		if (!this.started && connections.length === 0) {
			this.statusEntry.clear();
			return;
		}
		const active = connections.filter(c => c.state === 'active');
		const text = active.length === 0
			? localize('triage.companion.statusListening', "$(device-mobile) Phones")
			: active.length === 1
				? localize('triage.companion.statusOne', "$(device-mobile) {0} · {1}", active[0].name, active[0].permission === 'edit' ? localize('triage.companion.edit', "view and edit") : localize('triage.companion.view', "view only"))
				: localize('triage.companion.statusMany', "$(device-mobile) {0} phones", active.length);
		const tooltip = this.started
			? localize('triage.companion.statusTooltip', "Phones reach this laptop on UDP port {0} ({1}). Click to see them, change what they may do, or stop sharing.", this.started.port, this.started.addresses.join(', ') || localize('triage.companion.noAddress', "no LAN address"))
			: localize('triage.companion.statusTooltipOff', "Phones");
		const entry = { name: localize('triage.companion.statusName', "Triage Phones"), text, ariaLabel: text, tooltip, command: COMPANION_COMMANDS.phones };
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, COMPANION_STATUS_ID, StatusbarAlignment.RIGHT, 101);
		}
	}

	/** Keeps the laptop awake while a phone is connected (the setting; `code tunnel` does the same). */
	private updateKeepAwake(): void {
		const wanted = this.active().length > 0 && this.configurationService.getValue<boolean>(COMPANION_SETTINGS.keepAwake) !== false;
		if (wanted && this.keepAwake === undefined) {
			this.keepAwake = -1;
			void this.nativeHostService.startPowerSaveBlocker('prevent-app-suspension').then(id => { this.keepAwake = id; }, () => { this.keepAwake = undefined; });
		} else if (!wanted && this.keepAwake !== undefined && this.keepAwake >= 0) {
			void this.nativeHostService.stopPowerSaveBlocker(this.keepAwake);
			this.keepAwake = undefined;
		}
	}

	override dispose(): void {
		clearTimeout(this.pairingTimer);
		clearTimeout(this.frameTimer);
		clearTimeout(this.sceneTimer);
		if (this.keepAwake !== undefined && this.keepAwake >= 0) {
			void this.nativeHostService.stopPowerSaveBlocker(this.keepAwake);
		}
		super.dispose();
	}
}
