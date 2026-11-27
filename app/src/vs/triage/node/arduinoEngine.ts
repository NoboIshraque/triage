/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Arduino engine (ROADMAP PA, ADR 0006): in a utility process of its own, it
 *  runs Triage's arduino-cli through the sim package (sim/src/arduino.ts, packaged
 *  in resources/app/engines/sim/) with the engine in resources/app/engines/arduino/:
 *  builds, uploads, the port watcher, the Library and Boards Managers, examples and
 *  the Serial Monitor. simEngineMain registers it on its own channel.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { IArduinoBoard, IArduinoBoardOption, IArduinoBuild, IArduinoEngine, IArduinoExample, IArduinoLibrary, IArduinoOutput, IArduinoPlatform, IArduinoPort, IArduinoProjectRef } from '../common/arduino/arduino.js';

/** The parts of the sim package this engine uses (sim/src/arduino.ts, firmware.ts, project.ts). */
interface Setup { readonly engine: { readonly root: string; readonly manifest: { arduinoCli: string; platform: string } }; readonly home: string }
interface ArduinoModule {
	findArduinoEngine(): { root: string; manifest: { arduinoCli: string; platform: string } } | { missing: string };
	prepareArduino(engine?: unknown): Setup;
	withAdditionalUrls(setup: Setup, urls: readonly string[]): Setup;
	loadFirmwareConfig(folder: string): { root: string; board: string; fqbn?: string; libraries: readonly string[]; firmwareDir: string };
	buildProjectFirmware(project: { root: string; firmwareDir: string; board: string; fqbn?: string }): Omit<IArduinoBuild, 'hex'> & { hex: string };
	ensureLibraries(setup: Setup, wanted: readonly string[], onOutput: (text: string) => void): Promise<void>;
	upload(setup: Setup, options: { fqbn: string; buildDir: string; port: string; protocol?: string }, onOutput: (text: string) => void): Promise<void>;
	listBoards(setup: Setup): IArduinoBoard[];
	boardOptions(setup: Setup, fqbn: string): IArduinoBoardOption[];
	listPorts(setup: Setup): IArduinoPort[];
	watchPorts(setup: Setup, onChange: (ports: IArduinoPort[]) => void): () => void;
	updateIndexes(setup: Setup, onOutput: (text: string) => void): Promise<void>;
	searchLibraries(setup: Setup, query: string): IArduinoLibrary[];
	installedLibraries(setup: Setup): IArduinoLibrary[];
	installLibrary(setup: Setup, name: string, version: string | undefined, onOutput: (text: string) => void): Promise<void>;
	uninstallLibrary(setup: Setup, name: string, onOutput: (text: string) => void): Promise<void>;
	listPlatforms(setup: Setup, query?: string): IArduinoPlatform[];
	installPlatform(setup: Setup, id: string, version: string | undefined, onOutput: (text: string) => void): Promise<void>;
	uninstallPlatform(setup: Setup, id: string, onOutput: (text: string) => void): Promise<void>;
	listExamples(setup: Setup, fqbn?: string): IArduinoExample[];
	createProject(options: { folder: string; name: string; fqbn: string; example?: string }): string;
	freeProjectName(parent: string, name: string): string;
	setProjectLibrary(root: string, name: string, version: string | undefined): string[];
	openMonitor(setup: Setup, options: { port: string; baud: number; fqbn?: string }, onData: (text: string) => void, onClose: (reason: string) => void): { send(text: string): void; close(): void };
}

export class ArduinoEngine implements IArduinoEngine {
	private readonly disposables = new DisposableStore();
	private readonly _onDidOutput = this.disposables.add(new Emitter<IArduinoOutput>());
	readonly onDidOutput = this._onDidOutput.event;
	private readonly _onDidChangePorts = this.disposables.add(new Emitter<readonly IArduinoPort[]>());
	readonly onDidChangePorts = this._onDidChangePorts.event;
	private readonly _onDidMonitor = this.disposables.add(new Emitter<{ readonly text: string } | { readonly closed: string }>());
	readonly onDidMonitor = this._onDidMonitor.event;

	private module: ArduinoModule | undefined;
	private baseSetup: Setup | undefined;
	private setup: Setup | undefined;
	private stopWatching: (() => void) | undefined;
	private monitor: { send(text: string): void; close(): void } | undefined;
	private lastPorts: readonly IArduinoPort[] = [];

	async start(folder: string, additionalUrls: readonly string[]): Promise<{ arduinoCli: string; home: string; platform: string }> {
		if (!this.module) {
			// The sim package finds the engine beside it (engines/arduino).
			process.env['TRIAGE_ARDUINO'] ??= join(folder, 'arduino');
			this.module = await import(pathToFileURL(join(folder, 'sim', 'dist', 'index.js')).href) as ArduinoModule;
		}
		const found = this.module.findArduinoEngine();
		if ('missing' in found) {
			throw new Error(found.missing);
		}
		// The first start copies the AVR platform into the user's Arduino folder.
		this.baseSetup = this.module.prepareArduino(found);
		this.setup = this.module.withAdditionalUrls(this.baseSetup, additionalUrls);
		if (!this.stopWatching) {
			this.stopWatching = this.module.watchPorts(this.setup, ports => {
				this.lastPorts = ports;
				this._onDidChangePorts.fire(ports);
			});
		}
		return { arduinoCli: found.manifest.arduinoCli, home: this.baseSetup.home, platform: found.manifest.platform };
	}

	private require(): { module: ArduinoModule; setup: Setup } {
		if (!this.module || !this.setup) {
			throw new Error('the Arduino engine is not started');
		}
		return { module: this.module, setup: this.setup };
	}

	private output(task: IArduinoOutput['task']): (text: string) => void {
		return text => this._onDidOutput.fire({ task, text });
	}

	async setAdditionalUrls(urls: readonly string[]): Promise<void> {
		if (this.module && this.baseSetup) {
			this.setup = this.module.withAdditionalUrls(this.baseSetup, urls);
		}
	}

	async build(project: IArduinoProjectRef): Promise<IArduinoBuild> {
		const { module, setup } = this.require();
		const config = module.loadFirmwareConfig(project.root);
		await module.ensureLibraries(setup, config.libraries, this.output('install'));
		const built = module.buildProjectFirmware({ ...config, board: project.board || config.board, ...(project.fqbn ? { fqbn: project.fqbn } : {}) });
		this._onDidOutput.fire({ task: 'build', text: built.output });
		return built;
	}

	async upload(project: IArduinoProjectRef, port: string, protocol?: string): Promise<void> {
		const { module, setup } = this.require();
		const built = await this.build(project);
		const buildDir = built.hex.slice(0, Math.max(built.hex.lastIndexOf('/'), built.hex.lastIndexOf('\\')));
		// Close the Serial Monitor first: the port can only be open once.
		this.monitor?.close();
		await module.upload(setup, { fqbn: built.fqbn, buildDir, port, ...(protocol && protocol !== 'serial' ? { protocol } : {}) }, this.output('upload'));
	}

	async boards(): Promise<IArduinoBoard[]> {
		const { module, setup } = this.require();
		return module.listBoards(setup);
	}

	async boardOptions(fqbn: string): Promise<IArduinoBoardOption[]> {
		const { module, setup } = this.require();
		return module.boardOptions(setup, fqbn);
	}

	async ports(): Promise<IArduinoPort[]> {
		return [...this.lastPorts];
	}

	async updateIndexes(): Promise<void> {
		const { module, setup } = this.require();
		await module.updateIndexes(setup, this.output('index'));
	}

	async searchLibraries(query: string): Promise<IArduinoLibrary[]> {
		const { module, setup } = this.require();
		return module.searchLibraries(setup, query);
	}

	async installedLibraries(): Promise<IArduinoLibrary[]> {
		const { module, setup } = this.require();
		return module.installedLibraries(setup);
	}

	async installLibrary(name: string, version?: string): Promise<void> {
		const { module, setup } = this.require();
		await module.installLibrary(setup, name, version, this.output('install'));
	}

	async uninstallLibrary(name: string): Promise<void> {
		const { module, setup } = this.require();
		await module.uninstallLibrary(setup, name, this.output('install'));
	}

	async platforms(query: string): Promise<IArduinoPlatform[]> {
		const { module, setup } = this.require();
		return module.listPlatforms(setup, query);
	}

	async installPlatform(id: string, version?: string): Promise<void> {
		const { module, setup } = this.require();
		await module.installPlatform(setup, id, version, this.output('install'));
	}

	async uninstallPlatform(id: string): Promise<void> {
		const { module, setup } = this.require();
		await module.uninstallPlatform(setup, id, this.output('install'));
	}

	async examples(fqbn?: string): Promise<IArduinoExample[]> {
		const { module, setup } = this.require();
		return module.listExamples(setup, fqbn);
	}

	async createProject(options: { folder: string; name: string; fqbn: string; example?: string }): Promise<string> {
		const { module } = this.require();
		mkdirSync(options.folder, { recursive: true });
		return module.createProject({ ...options, name: module.freeProjectName(options.folder, options.name) });
	}

	async setProjectLibrary(root: string, name: string, version?: string): Promise<readonly string[]> {
		const { module } = this.require();
		return module.setProjectLibrary(root, name, version);
	}

	async monitorOpen(port: string, baud: number, fqbn?: string): Promise<void> {
		const { module, setup } = this.require();
		this.monitor?.close();
		const monitor = module.openMonitor(setup, { port, baud, ...(fqbn ? { fqbn } : {}) },
			text => this._onDidMonitor.fire({ text }),
			reason => {
				if (this.monitor === monitor) {
					this.monitor = undefined;
				}
				this._onDidMonitor.fire({ closed: reason });
			});
		this.monitor = monitor;
	}

	async monitorSend(text: string): Promise<void> {
		if (!this.monitor) {
			throw new Error('the Serial Monitor is not connected');
		}
		this.monitor.send(text);
	}

	async monitorClose(): Promise<void> {
		this.monitor?.close();
		this.monitor = undefined;
	}

	dispose(): void {
		this.stopWatching?.();
		this.monitor?.close();
		this.disposables.dispose();
	}
}
