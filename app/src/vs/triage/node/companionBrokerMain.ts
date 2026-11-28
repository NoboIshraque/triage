/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The companion broker (ROADMAP PC-2, ADR 0005 decision 6): a utility process
 *  that runs triage_companion.node, the Rust WebTransport server, relay client
 *  and Noise sessions. It holds the pairing secrets and the certificates' keys
 *  while it runs, renews the certificate every 13 days, and passes the sessions'
 *  plaintext to the window, which decides what each phone may do.
 *  Patch 0002 adds this module to the build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'module';
import { networkInterfaces } from 'os';
import { join } from 'path';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { COMPANION_ADDON, CompanionCertificate, ICompanionAddon, ICompanionServer } from '../common/companion/addon.js';
import { COMPANION_BROKER_CHANNEL, CompanionBrokerEvent, ICompanionBroker, ICompanionBrokerStart, ICompanionBrokerStarted, ICompanionCertificateJson, ICompanionPairing, PAIRING_LIFETIME_MS } from '../common/companion/companionService.js';
import { base64UrlDecode, base64UrlEncode, formatCode } from '../common/companion/qr.js';

const RENEW_CHECK_MS = 3600_000;

function toJson(c: CompanionCertificate): ICompanionCertificateJson {
	return { der: base64UrlEncode(c.der), keyDer: base64UrlEncode(c.keyDer), notBefore: c.notBefore, notAfter: c.notAfter, hash: base64UrlEncode(c.hash) };
}

function fromJson(c: ICompanionCertificateJson): CompanionCertificate {
	return { der: base64UrlDecode(c.der), keyDer: base64UrlDecode(c.keyDer), notBefore: c.notBefore, notAfter: c.notAfter, hash: base64UrlDecode(c.hash) };
}

/** The machine's addresses that phones on the LAN may reach. */
function lanAddresses(addon: ICompanionAddon, port: number, override: string | undefined): string[] {
	if (override) {
		return [override.includes(':') && !override.startsWith('[') ? `[${override}]:${port}` : `${override}:${port}`];
	}
	const ips: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (!entry.internal) {
				ips.push(entry.address.split('%')[0]);
			}
		}
	}
	return addon.rankAddresses(ips, port);
}

class CompanionBroker implements ICompanionBroker {
	private readonly disposables = new DisposableStore();
	private readonly _onDidEvent = this.disposables.add(new Emitter<CompanionBrokerEvent>());
	readonly onDidEvent = this._onDidEvent.event;

	private addon: ICompanionAddon | undefined;
	private server: ICompanionServer | undefined;
	private certificates: CompanionCertificate[] = [];
	private addresses: string[] = [];
	private addressOverride: string | undefined;
	private listenPort = 0;
	private renewTimer: ReturnType<typeof setInterval> | undefined;
	private readonly pairings = new Map<string, ReturnType<typeof setTimeout>>();

	private fire(json: Record<string, unknown>, data?: Uint8Array): void {
		this._onDidEvent.fire([JSON.stringify(json), data ? VSBuffer.wrap(data) : VSBuffer.alloc(0)]);
	}

	async start(options: ICompanionBrokerStart): Promise<ICompanionBrokerStarted> {
		await this.stop();
		console.log(`[triage] companion broker: loading ${join(options.addonFolder, COMPANION_ADDON)}`);
		const addon = this.addon ??= createRequire(import.meta.url)(join(options.addonFolder, COMPANION_ADDON)) as ICompanionAddon;
		const keys = options.staticPrivate ? { private: base64UrlDecode(options.staticPrivate) } : addon.generateKeypair();
		const now = Date.now() / 1000;
		this.certificates = addon.planCertificates(options.certificates.map(fromJson), now);
		const current = addon.currentCertificate(this.certificates, now);
		if (!current) {
			throw new Error('no certificate to serve');
		}
		const server = this.server = new addon.CompanionServer(keys.private);
		server.setAllowedOrigins(options.origins);
		const port = await server.listen(options.port, current);
		console.log(`[triage] companion broker: listening on UDP ${port}`);
		this.addressOverride = options.address;
		this.listenPort = port;
		this.addresses = lanAddresses(addon, port, options.address);
		this.laptopKeyCache = addon.publicKey(keys.private);
		void this.pump(server);
		this.renewTimer = setInterval(() => void this.renew(), RENEW_CHECK_MS);
		return {
			port,
			addresses: this.addresses,
			staticPrivate: base64UrlEncode(keys.private),
			laptopKey: base64UrlEncode(addon.publicKey(keys.private)),
			certificates: this.certificates.map(toJson),
		};
	}

	/** Every 13 days the next certificate takes over; phones were given its hash. */
	private async renew(): Promise<void> {
		const addon = this.addon;
		const server = this.server;
		if (!addon || !server) {
			return;
		}
		const now = Date.now() / 1000;
		const before = this.certificates.map(c => base64UrlEncode(c.hash)).join();
		this.certificates = addon.planCertificates(this.certificates, now);
		if (this.certificates.map(c => base64UrlEncode(c.hash)).join() === before) {
			return;
		}
		const current = addon.currentCertificate(this.certificates, now);
		if (current) {
			await server.setCertificate(current);
		}
		this.fire({ kind: 'certificates', certificates: this.certificates.map(toJson) });
	}

	private async pump(server: ICompanionServer): Promise<void> {
		for (; ;) {
			const event = await server.nextEvent();
			if (!event || server !== this.server) {
				return;
			}
			this.fire({
				kind: event.kind,
				session: event.session,
				mode: event.mode,
				id: event.id ? base64UrlEncode(event.id) : undefined,
				phoneKey: event.phoneKey ? base64UrlEncode(event.phoneKey) : undefined,
				sas: event.sas,
				route: event.route,
				remote: event.remote,
				reason: event.reason,
				attempts: event.attempts,
				connected: event.connected,
			}, event.data);
		}
	}

	async stop(): Promise<void> {
		clearInterval(this.renewTimer);
		for (const timer of this.pairings.values()) {
			clearTimeout(timer);
		}
		this.pairings.clear();
		const server = this.server;
		this.server = undefined;
		await server?.shutdown();
	}

	private running(): { addon: ICompanionAddon; server: ICompanionServer } {
		if (!this.addon || !this.server) {
			throw new Error('the companion is not running');
		}
		return { addon: this.addon, server: this.server };
	}

	async newPairing(view: string, appUrl: string, relay: string | undefined, withCode: boolean): Promise<ICompanionPairing> {
		const { addon, server } = this.running();
		const now = Date.now();
		const current = addon.currentCertificate(this.certificates, now / 1000);
		if (!current) {
			throw new Error('no certificate to serve');
		}
		const id = addon.randomBytes(16);
		const secret = addon.randomBytes(32);
		const expires = now + PAIRING_LIFETIME_MS;
		server.addPairing(id, 'pair', secret, expires);
		const key = base64UrlEncode(id);
		let code: string | undefined;
		let codeMailbox: Uint8Array | undefined;
		if (withCode && relay) {
			code = addon.newCode();
			codeMailbox = addon.codeMailbox(code);
			server.addPairing(codeMailbox, 'code', addon.codePsk(code), expires);
		}
		this.pairings.set(key, setTimeout(() => void this.removePairing(key), PAIRING_LIFETIME_MS + 1000));
		const link = addon.qrLink({
			id, secret, certificateHash: current.hash, laptopKey: this.laptopKey(), expires: Math.floor(expires / 1000),
			view: (['board', 'schematic', '3d', 'sim'].includes(view) ? view : 'board') as 'board',
			addresses: this.refreshAddresses(), ...(relay ? { relay } : {}),
		}, appUrl);
		const { width, dark } = addon.qrModules(link);
		let modules = '';
		for (const module of dark) {
			modules += module ? '1' : '0';
		}
		return { id: key, link, width, modules, code: code ? formatCode(code) : undefined, codeMailbox: codeMailbox ? base64UrlEncode(codeMailbox) : undefined, expires };
	}

	private laptopKeyCache: Uint8Array | undefined;
	private laptopKey(): Uint8Array {
		if (!this.laptopKeyCache) {
			throw new Error('no laptop key');
		}
		return this.laptopKeyCache;
	}

	/** The laptop may have moved to another network since it started: look again. */
	private refreshAddresses(): string[] {
		if (this.addon && this.server) {
			this.addresses = lanAddresses(this.addon, this.listenPort, this.addressOverride);
		}
		return this.addresses;
	}

	async removePairing(id: string): Promise<void> {
		clearTimeout(this.pairings.get(id));
		this.pairings.delete(id);
		this.server?.removePairing(base64UrlDecode(id));
	}

	async consumePairing(id: string): Promise<void> {
		this.server?.consumePairing(base64UrlDecode(id));
	}

	async failPairing(id: string): Promise<number> {
		return this.server?.failPairing(base64UrlDecode(id)) ?? 0;
	}

	async setPhones(phones: readonly { mailbox: string; key: string }[]): Promise<void> {
		this.running().server.setPhones(phones.map(p => ({ mailbox: base64UrlDecode(p.mailbox), key: base64UrlDecode(p.key) })));
	}

	async setRelay(url: string | undefined, mailboxes: readonly string[]): Promise<void> {
		await this.running().server.setRelay(url ?? null, mailboxes.map(base64UrlDecode));
	}

	async send(session: number, data: VSBuffer, droppable: boolean): Promise<boolean> {
		const server = this.server;
		if (!server) {
			return false;
		}
		return droppable ? server.send(session, data.buffer) : server.sendWait(session, data.buffer);
	}

	async close(session: number, refusal: string, text: string): Promise<void> {
		await this.server?.close(session, refusal, text);
	}

	async info(): Promise<{ port: number | undefined; addresses: string[]; certificateHashes: string[]; sessions: number }> {
		return {
			port: this.server?.port() ?? undefined,
			addresses: this.refreshAddresses(),
			certificateHashes: this.certificates.map(c => base64UrlEncode(c.hash)),
			sessions: this.server?.sessions() ?? 0,
		};
	}
}

if (!isUtilityProcess(process)) {
	throw new Error('companionBrokerMain must run in a utility process');
}

const server = new UtilityProcessServer();
server.registerChannel(COMPANION_BROKER_CHANNEL, ProxyChannel.fromService(new CompanionBroker(), new DisposableStore()));
