/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Arduino IDE's panels in Triage (ROADMAP PA-3 … PA-6), all with buttons:
 *  the Library Manager, the Boards Manager and the examples in the Arduino side
 *  bar, and the Serial Monitor for a real board in the panel.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../base/browser/dom.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../workbench/services/path/common/pathService.js';
import { ARDUINO_COMMANDS, IArduinoExample, IArduinoLibrary, IArduinoPlatform, ITriageArduinoService } from '../../common/arduino/arduino.js';
import { ITriageProjectService } from '../../common/projectModel.js';
import { openExample } from './arduinoCommands.js';

/** A ViewPane with the services every Arduino panel uses. */
abstract class ArduinoPane extends ViewPane {
	protected readonly paneStore = new DisposableStore();
	protected root!: HTMLElement;
	protected status!: HTMLElement;

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
		@ITriageArduinoService protected readonly arduino: ITriageArduinoService,
		@INotificationService protected readonly notifications: INotificationService,
		@ICommandService protected readonly commandService: ICommandService,
		@ITriageProjectService protected readonly projectService: ITriageProjectService,
		@IHostService protected readonly hostService: IHostService,
		@IPathService protected readonly pathService: IPathService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.paneStore);
	}

	protected button(parent: HTMLElement, label: string, run: () => unknown, action: string, title?: string): HTMLButtonElement {
		const button = append(parent, $('button.triage-arduino-button')) as HTMLButtonElement;
		button.textContent = label;
		button.dataset['action'] = action;
		if (title) {
			button.title = title;
		}
		this.paneStore.add(addDisposableListener(button, EventType.CLICK, () => void run()));
		return button;
	}

	/** Runs a long task with the buttons off and its progress in the status line. */
	protected async busy(what: string, task: () => Promise<unknown>): Promise<boolean> {
		this.root.classList.add('busy');
		this.root.dataset['state'] = 'busy';
		this.status.textContent = what;
		const listener = this.arduino.onDidOutput(output => {
			const line = output.text.replace(/\r/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).pop();
			if (line) {
				this.status.textContent = `${what} ${line}`;
			}
		});
		try {
			await task();
			this.status.textContent = '';
			this.root.dataset['state'] = 'ready';
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.status.textContent = message;
			this.root.dataset['state'] = 'error';
			this.notifications.error(message);
			return false;
		} finally {
			listener.dispose();
			this.root.classList.remove('busy');
		}
	}

	protected get projectRoot(): string | undefined {
		const state = this.projectService.state;
		return state.kind === 'project' ? state.project.root : undefined;
	}
}

// --- Library Manager (PA-4) ---

export class LibraryManagerView extends ArduinoPane {
	private list!: HTMLElement;
	private search!: HTMLInputElement;
	private refreshed = false;

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.triage-arduino.triage-libraries'));
		const bar = append(this.root, $('.triage-arduino-bar'));
		this.search = append(bar, $('input.triage-arduino-search', { type: 'search', placeholder: localize('triage.arduino.searchLibraries', "Search libraries (SSD1306, DHT, Servo …)") })) as HTMLInputElement;
		this.paneStore.add(addDisposableListener(this.search, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				void this.find();
			}
		}));
		this.button(bar, localize('triage.arduino.search', "Search"), () => this.find(), 'search');
		this.button(bar, localize('triage.arduino.installed', "Installed"), () => this.showInstalled(), 'installed');
		this.button(bar, localize('triage.arduino.refresh', "Refresh"), () => this.refresh(true), 'refresh', localize('triage.arduino.refreshTitle', "Download Arduino's library index again"));
		this.status = append(this.root, $('.triage-arduino-status'));
		this.list = append(this.root, $('.triage-arduino-list'));
		void this.showInstalled();
	}

	/** Arduino's library index, downloaded the first time the manager searches. */
	private async refresh(force: boolean): Promise<void> {
		if (this.refreshed && !force) {
			return;
		}
		const engine = await this.arduino.engine();
		const ok = await this.busy(localize('triage.arduino.updatingIndex', "Downloading Arduino's library and board indexes…"), () => engine.updateIndexes());
		this.refreshed = ok || this.refreshed;
	}

	private async find(): Promise<void> {
		await this.refresh(false);
		const engine = await this.arduino.engine();
		let results: IArduinoLibrary[] = [];
		const query = this.search.value;
		if (await this.busy(localize('triage.arduino.searching', "Searching…"), async () => { results = await engine.searchLibraries(query); })) {
			this.renderLibraries(results.slice(0, 100), localize('triage.arduino.found', "{0} libraries", results.length));
		}
	}

	private async showInstalled(): Promise<void> {
		const engine = await this.arduino.engine();
		let results: IArduinoLibrary[] = [];
		if (await this.busy(localize('triage.arduino.listing', "Reading the installed libraries…"), async () => { results = await engine.installedLibraries(); })) {
			this.renderLibraries(results, localize('triage.arduino.installedCount', "{0} installed (the AVR platform's own are built in)", results.length));
		}
	}

	private renderLibraries(libraries: readonly IArduinoLibrary[], heading: string): void {
		clearNode(this.list);
		append(this.list, $('.triage-arduino-heading', undefined, heading));
		for (const library of libraries) {
			const row = append(this.list, $('.triage-arduino-item'));
			row.dataset['library'] = library.name;
			const title = append(row, $('.triage-arduino-title'));
			append(title, $('strong', undefined, library.name));
			if (library.author) {
				append(title, $('span.triage-arduino-note', undefined, ` ${localize('triage.arduino.by', "by {0}", library.author)}`));
			}
			if (library.installed) {
				append(title, $('span.triage-arduino-badge', undefined, localize('triage.arduino.installedBadge', "installed {0}", library.installed)));
			}
			if (library.sentence) {
				append(row, $('.triage-arduino-text', undefined, library.sentence));
			}
			const actions = append(row, $('.triage-arduino-actions'));
			const builtIn = library.location === 'platform' || library.location === 'ide';
			let version: HTMLSelectElement | undefined;
			if (library.versions.length > 0 && !builtIn) {
				version = append(actions, $('select.triage-arduino-version')) as HTMLSelectElement;
				for (const v of library.versions) {
					append(version, $('option', { value: v }, v));
				}
				version.value = library.installed && library.versions.includes(library.installed) ? library.installed : library.versions[0];
			}
			if (builtIn) {
				append(actions, $('span.triage-arduino-note', undefined, localize('triage.arduino.platformLibrary', "Part of the board's platform")));
				continue;
			}
			const install = this.button(actions, library.installed ? localize('triage.arduino.update', "Install this version") : localize('triage.arduino.install', "Install"), () => this.install(library.name, version?.value), 'install');
			install.dataset['library'] = library.name;
			if (library.installed) {
				const remove = this.button(actions, localize('triage.arduino.remove', "Remove"), () => this.remove(library.name), 'remove');
				remove.dataset['library'] = library.name;
			}
		}
	}

	/** Installs a library (and those it needs) and records it in the project's triage.toml. */
	private async install(name: string, version: string | undefined): Promise<void> {
		const engine = await this.arduino.engine();
		const root = this.projectRoot;
		const ok = await this.busy(localize('triage.arduino.installing', "Installing {0}…", name), async () => {
			await engine.installLibrary(name, version);
			if (root) {
				const installed = (await engine.installedLibraries()).find(l => l.name === name);
				await engine.setProjectLibrary(root, name, installed?.installed ?? version);
			}
		});
		if (ok) {
			this.root.dataset['installedLibrary'] = name;
			this.notifications.info(root
				? localize('triage.arduino.installedNote', "Installed {0}; the project's triage.toml now lists it.", name)
				: localize('triage.arduino.installedNoteNoProject', "Installed {0}.", name));
			await this.showInstalled();
		}
	}

	private async remove(name: string): Promise<void> {
		const engine = await this.arduino.engine();
		const root = this.projectRoot;
		if (await this.busy(localize('triage.arduino.removing', "Removing {0}…", name), async () => {
			await engine.uninstallLibrary(name);
			if (root) {
				await engine.setProjectLibrary(root, name, undefined);
			}
		})) {
			await this.showInstalled();
		}
	}
}

// --- Boards Manager (PA-5) ---

export class BoardsManagerView extends ArduinoPane {
	private list!: HTMLElement;
	private search!: HTMLInputElement;

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.triage-arduino.triage-boards'));
		const bar = append(this.root, $('.triage-arduino-bar'));
		this.search = append(bar, $('input.triage-arduino-search', { type: 'search', placeholder: localize('triage.arduino.searchBoards', "Search boards (esp32, pico, nano …)") })) as HTMLInputElement;
		this.paneStore.add(addDisposableListener(this.search, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				void this.show();
			}
		}));
		this.button(bar, localize('triage.arduino.search', "Search"), () => this.show(), 'search');
		this.button(bar, localize('triage.arduino.refresh', "Refresh"), () => this.refresh(), 'refresh', localize('triage.arduino.refreshBoardsTitle', "Download the board indexes again (Arduino's and the additional URLs')"));
		this.button(bar, localize('triage.arduino.urls', "More URLs…"), () => this.commandService.executeCommand(ARDUINO_COMMANDS.boardsUrls), 'urls', localize('triage.arduino.urlsTitle', "Additional Boards Manager URLs: package indexes for ESP32, Raspberry Pi Pico and other boards"));
		this.status = append(this.root, $('.triage-arduino-status'));
		this.list = append(this.root, $('.triage-arduino-list'));
		void this.show();
	}

	private async refresh(): Promise<void> {
		const engine = await this.arduino.engine();
		if (await this.busy(localize('triage.arduino.updatingIndex', "Downloading Arduino's library and board indexes…"), () => engine.updateIndexes())) {
			await this.show();
		}
	}

	private async show(): Promise<void> {
		const engine = await this.arduino.engine();
		let platforms: IArduinoPlatform[] = [];
		const query = this.search.value;
		if (await this.busy(localize('triage.arduino.listingBoards', "Reading the platforms…"), async () => { platforms = await engine.platforms(query); })) {
			this.renderPlatforms(platforms);
		}
	}

	private renderPlatforms(platforms: readonly IArduinoPlatform[]): void {
		clearNode(this.list);
		const note = platforms.length <= 1
			? localize('triage.arduino.boardsHint', "Click Refresh to see every board Arduino lists; More URLs… adds ESP32, Raspberry Pi Pico and others.")
			: localize('triage.arduino.platformsCount', "{0} platforms", platforms.length);
		append(this.list, $('.triage-arduino-heading', undefined, note));
		for (const platform of platforms) {
			const row = append(this.list, $('.triage-arduino-item'));
			row.dataset['platform'] = platform.id;
			const title = append(row, $('.triage-arduino-title'));
			append(title, $('strong', undefined, platform.name));
			append(title, $('span.triage-arduino-note', undefined, ` ${platform.id}${platform.maintainer ? ` · ${platform.maintainer}` : ''}`));
			if (platform.installed) {
				append(title, $('span.triage-arduino-badge', undefined, localize('triage.arduino.installedBadge', "installed {0}", platform.installed)));
			}
			if (platform.builtIn) {
				append(title, $('span.triage-arduino-badge', undefined, localize('triage.arduino.builtInBadge', "built into Triage")));
			}
			if (platform.simulated) {
				append(title, $('span.triage-arduino-badge.simulated', undefined, localize('triage.arduino.simulatedBadge', "Triage simulates some")));
			}
			if (platform.boards.length > 0) {
				const shown = platform.boards.slice(0, 8).join(', ');
				append(row, $('.triage-arduino-text', undefined, platform.boards.length > 8 ? `${shown} … (+${platform.boards.length - 8})` : shown));
			}
			const actions = append(row, $('.triage-arduino-actions'));
			let version: HTMLSelectElement | undefined;
			if (platform.versions.length > 0) {
				version = append(actions, $('select.triage-arduino-version')) as HTMLSelectElement;
				for (const v of platform.versions) {
					append(version, $('option', { value: v }, v));
				}
				version.value = platform.installed && platform.versions.includes(platform.installed) ? platform.installed : platform.versions[0];
			}
			if (!platform.builtIn || platform.versions.length > 1) {
				const install = this.button(actions, platform.installed ? localize('triage.arduino.update', "Install this version") : localize('triage.arduino.install', "Install"), () => this.install(platform, version?.value), 'install');
				install.dataset['platform'] = platform.id;
			}
			if (platform.installed && !platform.builtIn) {
				const remove = this.button(actions, localize('triage.arduino.remove', "Remove"), () => this.remove(platform), 'remove');
				remove.dataset['platform'] = platform.id;
			}
		}
	}

	private async install(platform: IArduinoPlatform, version: string | undefined): Promise<void> {
		const engine = await this.arduino.engine();
		if (await this.busy(localize('triage.arduino.installingPlatform', "Installing {0} (its compiler downloads from {1}, checksums checked; large platforms take minutes)…", platform.name, platform.maintainer || platform.id), () => engine.installPlatform(platform.id, version))) {
			this.root.dataset['installedPlatform'] = platform.id;
			this.notifications.info(localize('triage.arduino.platformInstalled', "Installed {0}. Pick one of its boards in the status bar to build for it.", platform.name));
			await this.show();
		}
	}

	private async remove(platform: IArduinoPlatform): Promise<void> {
		const engine = await this.arduino.engine();
		if (await this.busy(localize('triage.arduino.removingPlatform', "Removing {0}…", platform.name), () => engine.uninstallPlatform(platform.id))) {
			await this.show();
		}
	}
}

// --- Examples (PA-6) ---

export class ExamplesView extends ArduinoPane {
	private list!: HTMLElement;

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.triage-arduino.triage-examples'));
		const bar = append(this.root, $('.triage-arduino-bar'));
		this.button(bar, localize('triage.arduino.newProject', "New Project…"), () => this.commandService.executeCommand(ARDUINO_COMMANDS.newProject), 'new');
		this.button(bar, localize('triage.arduino.reloadExamples', "Reload"), () => this.show(), 'reload', localize('triage.arduino.reloadExamplesTitle', "Read the examples again (after installing a library)"));
		this.status = append(this.root, $('.triage-arduino-status'));
		this.list = append(this.root, $('.triage-arduino-list'));
		void this.show();
	}

	private async show(): Promise<void> {
		const engine = await this.arduino.engine();
		let examples: IArduinoExample[] = [];
		if (!await this.busy(localize('triage.arduino.listingExamples', "Reading the examples…"), async () => { examples = await engine.examples(this.arduino.fqbn); })) {
			return;
		}
		clearNode(this.list);
		append(this.list, $('.triage-arduino-heading', undefined, localize('triage.arduino.examplesHint', "Click an example: it opens as a new project (in a new window) to run in the simulator or upload.")));
		const groups = new Map<string, IArduinoExample[]>();
		for (const example of examples) {
			groups.set(example.group, [...(groups.get(example.group) ?? []), example]);
		}
		for (const [group, items] of groups) {
			const details = append(this.list, $('details.triage-arduino-group')) as HTMLDetailsElement;
			details.dataset['group'] = group;
			append(details, $('summary', undefined, items[0]?.builtIn ? group : localize('triage.arduino.libraryExamples', "{0} (library)", group)));
			for (const example of items) {
				const link = append(details, $('a.triage-arduino-example', { href: '#', role: 'button' }, example.name));
				link.dataset['example'] = `${group}/${example.name}`;
				link.title = example.path;
				this.paneStore.add(addDisposableListener(link, EventType.CLICK, e => {
					e.preventDefault();
					void openExample({
						arduino: this.arduino, configurationService: this.configurationService, pathService: this.pathService,
						hostService: this.hostService, notifications: this.notifications,
					}, example);
				}));
			}
		}
	}
}

// --- Serial Monitor (PA-3) ---

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000];
const LINE_ENDINGS: [string, string][] = [
	['', localize('triage.arduino.noLineEnding', "No line ending")],
	['\n', localize('triage.arduino.newline', "New line")],
	['\r', localize('triage.arduino.carriageReturn', "Carriage return")],
	['\r\n', localize('triage.arduino.both', "Both NL & CR")],
];

export class SerialMonitorView extends ArduinoPane {
	private output!: HTMLElement;
	private connect!: HTMLButtonElement;
	private baud!: HTMLSelectElement;
	private ending!: HTMLSelectElement;
	private autoscroll!: HTMLInputElement;
	private connected = false;
	private text = '';

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.root = append(container, $('.triage-arduino.triage-serial-monitor'));
		const bar = append(this.root, $('.triage-arduino-bar'));
		this.connect = this.button(bar, localize('triage.arduino.connect', "Connect"), () => this.toggle(), 'connect');
		this.baud = append(bar, $('select.triage-arduino-baud', { title: localize('triage.arduino.baud', "Baud rate: the speed in Serial.begin()") })) as HTMLSelectElement;
		for (const rate of BAUD_RATES) {
			append(this.baud, $('option', { value: String(rate) }, localize('triage.arduino.baudOption', "{0} baud", rate)));
		}
		this.baud.value = '9600';
		this.paneStore.add(addDisposableListener(this.baud, EventType.CHANGE, () => {
			if (this.connected) {
				void this.open();
			}
		}));
		this.ending = append(bar, $('select.triage-arduino-ending')) as HTMLSelectElement;
		for (const [value, label] of LINE_ENDINGS) {
			append(this.ending, $('option', { value }, label));
		}
		this.ending.value = '\n';
		const scroll = append(bar, $('label.triage-arduino-check'));
		this.autoscroll = append(scroll, $('input', { type: 'checkbox' })) as HTMLInputElement;
		this.autoscroll.checked = true;
		append(scroll, $('span', undefined, localize('triage.arduino.autoscroll', "Autoscroll")));
		this.button(bar, localize('triage.arduino.clear', "Clear"), () => { this.text = ''; this.output.textContent = ''; }, 'clear');
		this.status = append(this.root, $('.triage-arduino-status'));
		this.output = append(this.root, $('pre.triage-arduino-output'));
		const send = append(this.root, $('.triage-arduino-send'));
		const input = append(send, $('input', { type: 'text', placeholder: localize('triage.arduino.sendPlaceholder', "Message to send to the board") })) as HTMLInputElement;
		const doSend = () => {
			if (!input.value && !this.ending.value) {
				return;
			}
			void this.arduino.engine().then(engine => engine.monitorSend(input.value + this.ending.value)).then(() => { input.value = ''; }, error => { this.status.textContent = String(error); });
		};
		this.paneStore.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				doSend();
			}
		}));
		this.button(send, localize('triage.arduino.send', "Send"), doSend, 'send');
		this.paneStore.add(this.arduino.onDidMonitor(event => {
			if ('text' in event) {
				this.text = (this.text + event.text).slice(-200_000);
				this.output.textContent = this.text;
				this.root.dataset['received'] = String(this.text.length);
				if (this.autoscroll.checked) {
					this.output.scrollTop = this.output.scrollHeight;
				}
			} else {
				this.setConnected(false, event.closed || localize('triage.arduino.disconnected', "Disconnected."));
			}
		}));
		this.paneStore.add(this.arduino.onDidChangeSelection(() => this.renderPort()));
		this.renderPort();
	}

	private renderPort(): void {
		if (!this.connected) {
			const port = this.arduino.port;
			this.status.textContent = port
				? localize('triage.arduino.monitorReady', "Connect reads {0} on {1}. (The simulator's serial monitor is in the Sim tab.)", this.arduino.boardName ?? '', port.label)
				: localize('triage.arduino.monitorNoPort', "Plug the board in and pick its port in the status bar (the board's name at the bottom left).");
		}
	}

	private setConnected(connected: boolean, status: string): void {
		this.connected = connected;
		this.connect.textContent = connected ? localize('triage.arduino.disconnect', "Disconnect") : localize('triage.arduino.connect', "Connect");
		this.root.dataset['connected'] = String(connected);
		this.status.textContent = status;
	}

	private async open(): Promise<void> {
		const port = this.arduino.port;
		if (!port) {
			await this.commandService.executeCommand(ARDUINO_COMMANDS.selectBoard);
			if (!this.arduino.port) {
				return;
			}
		}
		const chosen = this.arduino.port;
		if (!chosen) {
			return;
		}
		try {
			const engine = await this.arduino.engine();
			await engine.monitorOpen(chosen.address, Number(this.baud.value), this.arduino.fqbn);
			this.setConnected(true, localize('triage.arduino.monitorConnected', "Connected to {0} at {1} baud.", chosen.label, this.baud.value));
		} catch (error) {
			this.setConnected(false, error instanceof Error ? error.message : String(error));
		}
	}

	private async toggle(): Promise<void> {
		if (this.connected) {
			const engine = await this.arduino.engine();
			await engine.monitorClose();
			this.setConnected(false, localize('triage.arduino.disconnected', "Disconnected."));
		} else {
			await this.open();
		}
	}
}
