/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The phone companion's buttons on the laptop (ROADMAP PC-2, PLAN §4.16 "What the
 *  user does"): the Show on Phone dropdown on Triage's tabs, the pairing dialog
 *  (QR code, typed code, the six digits, Allow with View only or View and edit),
 *  the Phones section of the Triage side bar, the Triage menu's entries and the
 *  settings. The status bar item and the notifications are the service's.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, IMenuItem, ISubmenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../workbench/browser/parts/views/viewPane.js';
import { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { ActiveEditorContext } from '../../../workbench/common/contextkeys.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { COMPANION_COMMANDS, COMPANION_DEFAULT_APP_URL, COMPANION_DEFAULT_PORT, COMPANION_SETTINGS, ICompanionPhone, ITriageCompanionService } from '../../common/companion/companionService.js';
import { CompanionPermission } from '../../common/companion/protocol.js';
import { TRIAGE_CATEGORY } from '../../common/triage.js';
import { TriageViewEditor, TriageViewInput } from '../triageViewEditor.js';

export const TRIAGE_PHONES_VIEW_ID = 'workbench.triage.phones';
export const ShowOnPhoneMenu = new MenuId('TriageShowOnPhone');

const PERMISSION_LABEL: Record<CompanionPermission, string> = {
	view: localize('triage.companion.viewOnly', "View only"),
	edit: localize('triage.companion.viewAndEdit', "View and edit"),
};

/** The tab the user is on, as a phone view ("board" when it's code or another editor). */
function currentView(editorService: IEditorService): string {
	const input = editorService.activeEditor;
	if (input instanceof TriageViewInput && ['board', 'schematic', '3d', 'sim'].includes(input.view.kind)) {
		return input.view.kind;
	}
	return 'board';
}

/** Asks View only or View and edit (every time the laptop shares, ADR 0005 decision 5). */
async function askPermission(quickInput: IQuickInputService, name: string, proposed: CompanionPermission): Promise<CompanionPermission | undefined> {
	const items: (IQuickPickItem & { id: CompanionPermission })[] = [
		{ id: 'view', label: PERMISSION_LABEL.view, description: localize('triage.companion.viewDetail', "pan, zoom, tap parts, watch the simulation") },
		{ id: 'edit', label: PERMISSION_LABEL.edit, description: localize('triage.companion.editDetail', "also change values, move parts, run the simulation") },
	];
	const picked = await quickInput.pick(items, {
		placeHolder: localize('triage.companion.askPermission', "What may {0} do?", name),
		activeItem: items.find(i => i.id === proposed),
	});
	return picked?.id;
}

export function registerCompanionUi(): void {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'triage.companion',
		title: localize('triage.companion.settings', "Triage: Phones and Tablets"),
		type: 'object',
		properties: {
			[COMPANION_SETTINGS.enabled]: {
				type: 'boolean', default: false, scope: ConfigurationScope.APPLICATION,
				description: localize('triage.companion.enabled', "Let paired phones and tablets reconnect while Triage runs. Off until you pair a phone with Show on Phone; nothing listens before."),
			},
			[COMPANION_SETTINGS.port]: {
				type: 'number', default: COMPANION_DEFAULT_PORT, minimum: 1024, maximum: 65535, scope: ConfigurationScope.APPLICATION,
				description: localize('triage.companion.port', "The UDP port phones reach this laptop on (WebTransport)."),
			},
			[COMPANION_SETTINGS.address]: {
				type: 'string', default: '', scope: ConfigurationScope.APPLICATION,
				description: localize('triage.companion.address', "This laptop's LAN address for QR codes, if the one Triage finds is wrong (empty: found automatically)."),
			},
			[COMPANION_SETTINGS.relay]: {
				type: 'string', default: '', scope: ConfigurationScope.APPLICATION,
				description: localize('triage.companion.relay', "The relay phones use when they can't reach this laptop directly (wss://…). It only forwards sealed messages. Empty: the same network only."),
			},
			[COMPANION_SETTINGS.appUrl]: {
				type: 'string', default: COMPANION_DEFAULT_APP_URL, scope: ConfigurationScope.APPLICATION,
				description: localize('triage.companion.appUrl', "Where the Triage phone app is published (the QR codes open it). Moving it makes paired phones pair again."),
			},
			[COMPANION_SETTINGS.keepAwake]: {
				type: 'boolean', default: true, scope: ConfigurationScope.APPLICATION,
				description: localize('triage.companion.keepAwake', "Keep the laptop awake while a phone is connected."),
			},
		},
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: COMPANION_COMMANDS.pair,
				title: localize2('triage.companion.pair', "Show on Phone: Pair a New Phone…"),
				category: TRIAGE_CATEGORY,
				icon: Codicon.deviceMobile,
				f1: true,
				menu: [{ id: ShowOnPhoneMenu, group: '1_pair', order: 0 }],
			});
		}
		run(accessor: ServicesAccessor, view?: string): Promise<void> {
			return accessor.get(ITriageCompanionService).startPairing(typeof view === 'string' ? view : currentView(accessor.get(IEditorService)));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: COMPANION_COMMANDS.showOn, title: localize2('triage.companion.showOn', "Show on a Paired Phone…"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor, phoneId?: string, view?: string): Promise<void> {
			const companion = accessor.get(ITriageCompanionService);
			const quickInput = accessor.get(IQuickInputService);
			const editorService = accessor.get(IEditorService);
			let phone = companion.phones.find(p => p.id === phoneId);
			if (!phone) {
				if (companion.phones.length === 0) {
					return companion.startPairing(currentView(editorService));
				}
				const picked = await quickInput.pick(companion.phones.map(p => ({ label: p.name, id: p.id })), { placeHolder: localize('triage.companion.pickPhone', "Show on which phone?") });
				phone = companion.phones.find(p => p.id === picked?.id);
			}
			if (!phone) {
				return;
			}
			const permission = await askPermission(quickInput, phone.name, phone.permission);
			if (permission) {
				await companion.showOn(phone.id, typeof view === 'string' ? view : currentView(editorService), permission);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: COMPANION_COMMANDS.phones,
				title: localize2('triage.companion.phones', "Phones and Tablets…"),
				category: TRIAGE_CATEGORY,
				f1: true,
				menu: [{ id: ShowOnPhoneMenu, group: '3_manage', order: 0 }],
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return pickPhone(accessor.get(ITriageCompanionService), accessor.get(IQuickInputService), accessor.get(ICommandService), accessor.get(IEditorService));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: COMPANION_COMMANDS.stop,
				title: localize2('triage.companion.stop', "Stop Sharing with Phones"),
				category: TRIAGE_CATEGORY,
				f1: true,
				menu: [{ id: ShowOnPhoneMenu, group: '3_manage', order: 1 }],
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ITriageCompanionService).stopSharing();
		}
	});

	// Internal: the Phones section's and the quick pick's buttons.
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: COMPANION_COMMANDS.setPermission, title: localize2('triage.companion.setPermission', "Change a Phone's Permission"), category: TRIAGE_CATEGORY, f1: false });
		}
		run(accessor: ServicesAccessor, session: number, permission: CompanionPermission): Promise<void> {
			return accessor.get(ITriageCompanionService).setPermission(session, permission);
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: COMPANION_COMMANDS.allowEditing, title: localize2('triage.companion.allowEditingCommand', "Allow a Phone to Edit"), category: TRIAGE_CATEGORY, f1: false });
		}
		run(accessor: ServicesAccessor, session: number): Promise<void> {
			return accessor.get(ITriageCompanionService).setPermission(session, 'edit');
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: COMPANION_COMMANDS.disconnect, title: localize2('triage.companion.disconnect', "Disconnect a Phone"), category: TRIAGE_CATEGORY, f1: false });
		}
		run(accessor: ServicesAccessor, session: number): Promise<void> {
			return accessor.get(ITriageCompanionService).disconnect(session);
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: COMPANION_COMMANDS.remove, title: localize2('triage.companion.remove', "Remove a Phone"), category: TRIAGE_CATEGORY, f1: false });
		}
		run(accessor: ServicesAccessor, phoneId: string): Promise<void> {
			return accessor.get(ITriageCompanionService).removePhone(phoneId);
		}
	});

	// The dropdown beside the tab's window button (PLAN §4.16 step 1).
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		submenu: ShowOnPhoneMenu,
		title: localize('triage.companion.showOnPhone', "Show on Phone"),
		icon: Codicon.deviceMobile,
		group: 'navigation',
		order: 0.9,
		when: ContextKeyExpr.equals(ActiveEditorContext.key, TriageViewEditor.ID),
	} satisfies ISubmenuItem);
}

/** The Phones quick pick (the status bar item opens it). */
async function pickPhone(companion: ITriageCompanionService, quickInput: IQuickInputService, commands: ICommandService, editorService: IEditorService): Promise<void> {
	type Item = IQuickPickItem & { run: () => Promise<unknown> };
	const items: Item[] = [];
	for (const connection of companion.connections.filter(c => c.state === 'active')) {
		const other: CompanionPermission = connection.permission === 'edit' ? 'view' : 'edit';
		items.push({
			label: `$(device-mobile) ${connection.name}`,
			description: `${PERMISSION_LABEL[connection.permission]} · ${connection.route === 'lan' ? localize('triage.companion.lan', "same network") : localize('triage.companion.relayRoute', "through the relay")}`,
			detail: other === 'edit' ? localize('triage.companion.allowEditingPick', "Allow editing") : localize('triage.companion.viewOnlyPick', "Make it view only"),
			run: () => companion.setPermission(connection.session, other),
		});
		items.push({ label: `$(debug-disconnect) ${localize('triage.companion.disconnectNamed', "Disconnect {0}", connection.name)}`, run: () => companion.disconnect(connection.session) });
	}
	for (const phone of companion.phones) {
		items.push({ label: `$(device-mobile) ${localize('triage.companion.showOnNamed', "Show on {0}…", phone.name)}`, run: () => commands.executeCommand(COMPANION_COMMANDS.showOn, phone.id, currentView(editorService)) });
		items.push({ label: `$(trash) ${localize('triage.companion.removeNamed', "Remove {0}", phone.name)}`, run: () => companion.removePhone(phone.id) });
	}
	items.push({ label: `$(add) ${localize('triage.companion.pairNew', "Pair a New Phone…")}`, run: () => companion.startPairing(currentView(editorService)) });
	if (companion.connections.length > 0 || companion.phones.length > 0) {
		items.push({ label: `$(circle-slash) ${localize('triage.companion.stopSharing', "Stop Sharing with Phones")}`, run: () => companion.stopSharing() });
	}
	const picked = await quickInput.pick(items, { placeHolder: localize('triage.companion.phonesPlaceholder', "Phones and tablets") });
	await picked?.run();
}

/** Keeps "Show on <phone>" entries in the dropdown, one per paired phone. */
export class CompanionMenus extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.triageCompanionMenus';
	private readonly items = this._register(new DisposableStore());

	constructor(@ITriageCompanionService private readonly companion: ITriageCompanionService) {
		super();
		this.update();
		this._register(companion.onDidChange(() => this.update()));
	}

	private signature = '';
	private update(): void {
		const signature = this.companion.phones.map(p => `${p.id}:${p.name}`).join('|');
		if (signature === this.signature) {
			return;
		}
		this.signature = signature;
		this.items.clear();
		for (const [order, phone] of this.companion.phones.entries()) {
			// A command per phone: menu entries can't carry arguments.
			const id = `${COMPANION_COMMANDS.showOn}.${order}`;
			this.items.add(CommandsRegistry.registerCommand(id, accessor => accessor.get(ICommandService).executeCommand(COMPANION_COMMANDS.showOn, phone.id)));
			this.items.add(MenuRegistry.appendMenuItem(ShowOnPhoneMenu, {
				command: { id, title: localize('triage.companion.showOnItem', "Show on {0}…", phone.name) },
				group: '2_phones',
				order,
			} satisfies IMenuItem) as IDisposable);
		}
	}
}

/** The pairing dialog: shown while the service's pairing state is set. */
export class CompanionPairingDialog extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.triageCompanionDialog';
	private element: HTMLElement | undefined;
	private readonly content = this._register(new DisposableStore());
	private readonly ticker = this._register(new MutableDisposable());
	private nameDraft: string | undefined;

	constructor(
		@ITriageCompanionService private readonly companion: ITriageCompanionService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(companion.onDidChange(() => this.render()));
		this._register({ dispose: () => this.element?.remove() });
	}

	private render(): void {
		const state = this.companion.pairing;
		if (!state) {
			this.element?.remove();
			this.element = undefined;
			this.content.clear();
			this.ticker.clear();
			this.nameDraft = undefined;
			return;
		}
		if (!this.element) {
			this.element = append(this.layoutService.mainContainer, $('.triage-companion-backdrop'));
			this.element.tabIndex = -1;
		}
		this.content.clear();
		clearNode(this.element);
		const dialog = append(this.element, $('.triage-companion-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-label', localize('triage.companion.dialogTitle', "Show on a phone"));
		const header = append(dialog, $('.triage-companion-header'));
		append(header, $('h2', undefined, localize('triage.companion.dialogHeading', "Show on a phone")));
		const close = this.content.add(new Button(header, { ...defaultButtonStyles, secondary: true, title: localize('triage.companion.close', "Close") }));
		close.label = '✕';
		close.element.classList.add('triage-companion-close');
		this.content.add(close.onDidClick(() => this.companion.stopPairing()));
		this.content.add(addDisposableListener(this.element, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.companion.stopPairing();
			}
		}));

		if (state.request) {
			dialog.dataset['state'] = 'request';
			dialog.dataset['sas'] = state.request.sas;
			append(dialog, $('p', undefined, localize('triage.companion.answered', "A phone answered. Check that it shows the same six digits:")));
			append(dialog, $('.triage-companion-sas', undefined, `${state.request.sas.slice(0, 3)} ${state.request.sas.slice(3)}`));
			const row = append(dialog, $('.triage-companion-name'));
			append(row, $('label', undefined, localize('triage.companion.nameLabel', "Name:")));
			const input = append(row, $('input.triage-companion-name-input')) as HTMLInputElement;
			input.value = this.nameDraft ?? state.request.name;
			input.maxLength = 60;
			this.content.add(addDisposableListener(input, EventType.INPUT, () => { this.nameDraft = input.value; }));
			append(dialog, $('p.triage-companion-small', undefined, state.request.route === 'lan'
				? localize('triage.companion.viaLan', "On this network, directly.")
				: localize('triage.companion.viaRelay', "Through the relay (it sees only sealed messages).")));
			const buttons = append(dialog, $('.triage-companion-buttons'));
			const allow = (permission: CompanionPermission, label: string, secondary: boolean) => {
				const button = this.content.add(new Button(buttons, { ...defaultButtonStyles, secondary }));
				button.label = label;
				button.element.dataset['answer'] = permission;
				this.content.add(button.onDidClick(() => void this.companion.answerPairing(permission, input.value)));
			};
			allow('view', localize('triage.companion.allowView', "Allow: View Only"), false);
			allow('edit', localize('triage.companion.allowEdit', "Allow: View and Edit"), true);
			const deny = this.content.add(new Button(buttons, { ...defaultButtonStyles, secondary: true }));
			deny.label = localize('triage.companion.deny', "Deny");
			deny.element.dataset['answer'] = 'deny';
			this.content.add(deny.onDidClick(() => void this.companion.answerPairing('deny')));
			append(dialog, $('p.triage-companion-small', undefined, localize('triage.companion.digitsWhy', "Only allow a phone that shows these digits: anyone who can see this screen could scan the code.")));
			this.ticker.clear();
			return;
		}

		if (state.error || state.stopped || !state.qr) {
			dialog.dataset['state'] = state.error ? 'error' : state.stopped ? 'stopped' : 'starting';
			append(dialog, $('p', undefined, state.error ?? (state.stopped
				? localize('triage.companion.stopped', "The code stopped working.")
				: localize('triage.companion.starting', "Starting…"))));
			if (state.stopped || state.error) {
				const again = this.content.add(new Button(dialog, { ...defaultButtonStyles }));
				again.label = localize('triage.companion.showAgain', "Show Again");
				this.content.add(again.onDidClick(() => void this.companion.startPairing(state.view)));
			}
			this.ticker.clear();
			return;
		}

		const qr = state.qr;
		dialog.dataset['state'] = 'qr';
		dialog.dataset['link'] = qr.link;
		append(dialog, $('p', undefined, localize('triage.companion.scan', "Scan this with the phone's camera. Then compare the six digits on both screens.")));
		const canvas = append(dialog, $('canvas.triage-companion-qr')) as HTMLCanvasElement;
		drawQr(canvas, qr.width, qr.modules);
		if (qr.code) {
			append(dialog, $('p', undefined, localize('triage.companion.orType', "No camera? In the Triage phone app, type:")));
			append(dialog, $('.triage-companion-code', undefined, qr.code));
		}
		const countdown = append(dialog, $('p.triage-companion-small'));
		const tick = () => {
			const seconds = Math.max(0, Math.round((qr.expires - Date.now()) / 1000));
			countdown.textContent = localize('triage.companion.countdown', "This code works for {0} s; a new one comes every 45 s.", seconds);
		};
		tick();
		const timer = setInterval(tick, 1000);
		this.ticker.value = { dispose: () => clearInterval(timer) };
		const buttons = append(dialog, $('.triage-companion-buttons'));
		const copy = this.content.add(new Button(buttons, { ...defaultButtonStyles, secondary: true }));
		copy.label = localize('triage.companion.copyLink', "Copy Link");
		this.content.add(copy.onDidClick(() => void this.clipboardService.writeText(qr.link)));
		const appUrl = this.configurationService.getValue<string>(COMPANION_SETTINGS.appUrl) || COMPANION_DEFAULT_APP_URL;
		const where = state.listening?.addresses.length
			? localize('triage.companion.where', "Phones on this network reach the laptop at {0} (UDP). The app: {1}", state.listening.addresses.map(a => a.replace(/:\d+$/, '')).join(', '), appUrl)
			: localize('triage.companion.noLan', "No network address was found: phones can only use the relay. The app: {0}", appUrl);
		append(dialog, $('p.triage-companion-small', undefined, where));
		this.element.focus();
	}
}

/** Draws QR modules ("1" dark) with a four-module quiet zone. */
function drawQr(canvas: HTMLCanvasElement, width: number, modules: string): void {
	const scale = Math.max(3, Math.floor(260 / (width + 8)));
	const size = (width + 8) * scale;
	canvas.width = size;
	canvas.height = size;
	canvas.style.width = `${size}px`;
	canvas.style.height = `${size}px`;
	const context = canvas.getContext('2d');
	if (!context) {
		return;
	}
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, size, size);
	context.fillStyle = '#000000';
	for (let y = 0; y < width; y++) {
		for (let x = 0; x < width; x++) {
			if (modules[y * width + x] === '1') {
				context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
			}
		}
	}
}

/** The Phones section of the Triage side bar. */
export class TriagePhonesView extends ViewPane {
	private list: HTMLElement | undefined;
	private readonly rows = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ITriageCompanionService private readonly companion: ITriageCompanionService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(companion.onDidChange(() => this.update()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.list = append(container, $('.triage-phones'));
		this.update();
	}

	private update(): void {
		const body = this.list;
		if (!body) {
			return;
		}
		this.rows.clear();
		clearNode(body);
		const connections = this.companion.connections.filter(c => c.state === 'active');
		const button = (parent: HTMLElement, label: string, run: () => unknown, secondary = true) => {
			const b = this.rows.add(new Button(parent, { ...defaultButtonStyles, secondary }));
			b.label = label;
			this.rows.add(b.onDidClick(() => void run()));
			return b;
		};
		if (this.companion.phones.length === 0) {
			append(body, $('p.triage-note', undefined, localize('triage.phones.none', "See the schematic, board, 3D model and simulation on your phone or tablet. The laptop does the work; the phone needs only a browser.")));
		}
		for (const phone of this.companion.phones) {
			const connection = connections.find(c => c.phoneId === phone.id);
			const row = append(body, $('.triage-phone'));
			row.dataset['phone'] = phone.name;
			row.dataset['state'] = connection ? connection.permission : 'offline';
			append(row, $('.triage-phone-name', undefined, phone.name));
			append(row, $('.triage-phone-detail', undefined, connection
				? `${PERMISSION_LABEL[connection.permission]} · ${connection.route === 'lan' ? localize('triage.phones.lan', "same network") : localize('triage.phones.relay', "relay")}${connection.edits ? ` · ${localize('triage.phones.edits', "{0} edits", connection.edits)}` : ''}`
				: localize('triage.phones.lastSeen', "not connected · last seen {0}", new Date(phone.lastSeen).toLocaleString())));
			const buttons = append(row, $('.triage-phone-buttons'));
			if (connection) {
				const other: CompanionPermission = connection.permission === 'edit' ? 'view' : 'edit';
				button(buttons, other === 'edit' ? localize('triage.phones.allowEditing', "Allow Editing") : localize('triage.phones.viewOnly', "View Only"), () => this.companion.setPermission(connection.session, other)).element.dataset['action'] = 'permission';
				button(buttons, localize('triage.phones.disconnect', "Disconnect"), () => this.companion.disconnect(connection.session));
			} else {
				button(buttons, localize('triage.phones.showOn', "Show on…"), () => this.commandService.executeCommand(COMPANION_COMMANDS.showOn, phone.id, currentView(this.editorService)));
			}
			button(buttons, localize('triage.phones.remove', "Remove"), () => this.removePhone(phone)).element.dataset['action'] = 'remove';
		}
		const pending = this.companion.connections.filter(c => c.state === 'pending');
		for (const connection of pending) {
			append(body, $('p.triage-note', undefined, localize('triage.phones.pending', "{0} is waiting for Allow in the pairing dialog.", connection.name)));
		}
		const actions = append(body, $('.triage-phone-actions'));
		button(actions, localize('triage.phones.pair', "Pair a New Phone…"), () => this.companion.startPairing(currentView(this.editorService)), false).element.dataset['action'] = 'pair';
	}

	private removePhone(phone: ICompanionPhone): Promise<void> {
		return this.companion.removePhone(phone.id);
	}
}
