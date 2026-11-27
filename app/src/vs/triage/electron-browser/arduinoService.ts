/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The window's side of the Arduino IDE built in (ROADMAP PA): starts the Arduino
 *  engine in a utility process on first use, keeps the selected board and port
 *  (the board and port picker in the status bar), and runs Build and Upload with
 *  their output in the Output panel and the compiler's messages in Problems.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { URI } from '../../base/common/uri.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { localize } from '../../nls.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../platform/markers/common/markers.js';
import { INotificationService, Severity } from '../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../workbench/services/statusbar/browser/statusbar.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { ARDUINO_BOARDS_URLS_SETTING, ARDUINO_COMMANDS, ARDUINO_ENGINE_CHANNEL, ArduinoTask, IArduinoBuild, IArduinoEngine, IArduinoOutput, IArduinoPort, IArduinoProjectRef, ITriageArduinoService } from '../common/arduino/arduino.js';
import { ITriageProjectService } from '../common/projectModel.js';
import { SIM_ENGINE_MODULE } from '../common/sim/simService.js';

/** The board profiles Triage simulates, and their boards (sim/src/arduino.ts BOARD_FQBNS). */
const PROFILE_FQBNS: Record<string, { fqbn: string; name: string }> = {
	'arduino-uno': { fqbn: 'arduino:avr:uno', name: 'Arduino Uno' },
	'arduino-nano': { fqbn: 'arduino:avr:nano:cpu=atmega328', name: 'Arduino Nano' },
	'arduino-mega': { fqbn: 'arduino:avr:mega:cpu=atmega2560', name: 'Arduino Mega or Mega 2560' },
};

const BUILD_MARKERS = 'triage.arduino.build';
const STORAGE_BOARD = 'triage.arduino.board';
const STORAGE_PORT = 'triage.arduino.port';
export const ARDUINO_STATUS_ID = 'triage.arduino.status';

export class TriageArduinoService extends Disposable implements ITriageArduinoService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<void>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;
	private readonly _onDidChangePorts = this._register(new Emitter<readonly IArduinoPort[]>());
	readonly onDidChangePorts = this._onDidChangePorts.event;
	private readonly _onDidOutput = this._register(new Emitter<IArduinoOutput>());
	readonly onDidOutput = this._onDidOutput.event;
	private readonly _onDidMonitor = this._register(new Emitter<{ readonly text: string } | { readonly closed: string }>());
	readonly onDidMonitor = this._onDidMonitor.event;
	private readonly _onDidChangeTask = this._register(new Emitter<ArduinoTask>());
	readonly onDidChangeTask = this._onDidChangeTask.event;

	private picked: { fqbn: string; name: string } | undefined;
	private _port: IArduinoPort | undefined;
	private _ports: readonly IArduinoPort[] = [];
	private _task: ArduinoTask = { kind: 'idle' };
	private engineProcess: Promise<IArduinoEngine> | undefined;
	private readonly worker = this._register(new MutableDisposable());
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly workerService: IUtilityProcessWorkerWorkbenchService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITriageProjectService private readonly projectService: ITriageProjectService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMarkerService private readonly markerService: IMarkerService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const saved = this.storageService.get(STORAGE_BOARD, StorageScope.WORKSPACE);
		if (saved) {
			try {
				this.picked = JSON.parse(saved) as { fqbn: string; name: string };
			} catch {
				// a stale entry
			}
		}
		this._register(this.projectService.onDidChangeState(() => this.renderStatus()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ARDUINO_BOARDS_URLS_SETTING) && this.engineProcess) {
				void this.engineProcess.then(engine => engine.setAdditionalUrls(this.additionalUrls()));
			}
		}));
		this.renderStatus();
	}

	private additionalUrls(): string[] {
		const value = this.configurationService.getValue<unknown>(ARDUINO_BOARDS_URLS_SETTING);
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
	}

	// --- the selected board and port ---

	/** The project's board (triage.toml), unless one was picked in the status bar. */
	private get projectBoard(): { fqbn: string; name: string } | undefined {
		const state = this.projectService.state;
		if (state.kind !== 'project') {
			return undefined;
		}
		const fqbn = state.project.fqbn;
		if (fqbn) {
			return { fqbn, name: fqbn };
		}
		return PROFILE_FQBNS[state.project.board ?? ''];
	}

	get fqbn(): string | undefined {
		return (this.picked ?? this.projectBoard)?.fqbn;
	}

	get boardName(): string | undefined {
		return (this.picked ?? this.projectBoard)?.name;
	}

	get port(): IArduinoPort | undefined {
		return this._port;
	}

	get ports(): readonly IArduinoPort[] {
		return this._ports;
	}

	get task(): ArduinoTask {
		return this._task;
	}

	async setBoard(fqbn: string, name: string): Promise<void> {
		this.picked = { fqbn, name };
		this.storageService.store(STORAGE_BOARD, JSON.stringify(this.picked), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.renderStatus();
		this._onDidChangeSelection.fire();
	}

	setPort(port: IArduinoPort | undefined): void {
		this._port = port;
		this.storageService.store(STORAGE_PORT, port?.address, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.renderStatus();
		this._onDidChangeSelection.fire();
	}

	private setTask(task: ArduinoTask): void {
		this._task = task;
		this._onDidChangeTask.fire(task);
		this.renderStatus();
	}

	private renderStatus(): void {
		const board = this.boardName ?? localize('triage.arduino.noBoard', "Select Board");
		const port = this._port ? ` · ${this._port.label}` : '';
		const busy = this._task.kind === 'busy' ? '$(sync~spin) ' : '';
		this.statusEntry.value ??= this.statusbarService.addEntry({
			name: localize('triage.arduino.statusName', "Board and Port"),
			text: '', ariaLabel: '', command: ARDUINO_COMMANDS.selectBoard,
		}, ARDUINO_STATUS_ID, StatusbarAlignment.LEFT, -102);
		this.statusEntry.value.update({
			name: localize('triage.arduino.statusName', "Board and Port"),
			text: `${busy}$(circuit-board) ${board}${port}`,
			ariaLabel: localize('triage.arduino.statusAria', "Board {0}{1}. Click to pick the board and port.", board, port),
			tooltip: this._task.kind === 'busy'
				? this._task.what
				: localize('triage.arduino.statusTooltip', "The board Build and Upload are for, and its USB port. Click to change."),
			command: ARDUINO_COMMANDS.selectBoard,
		});
	}

	// --- the engine ---

	engine(): Promise<IArduinoEngine> {
		if (!this.engineProcess) {
			this.engineProcess = this.createEngine();
			this.engineProcess.catch(error => {
				this.engineProcess = undefined;
				this.setTask({ kind: 'error', message: String(error) });
			});
		}
		return this.engineProcess;
	}

	private async createEngine(): Promise<IArduinoEngine> {
		const worker = await this.workerService.createWorker({
			moduleId: SIM_ENGINE_MODULE,
			type: 'triageArduinoEngine',
			name: 'triage-arduino-engine',
		});
		this.worker.value = worker;
		void worker.onDidTerminate.then(() => {
			if (this.worker.value === worker) {
				this.engineProcess = undefined;
			}
		});
		const engine = ProxyChannel.toService<IArduinoEngine>(worker.client.getChannel(ARDUINO_ENGINE_CHANNEL));
		this._register(engine.onDidOutput(output => this._onDidOutput.fire(output)));
		this._register(engine.onDidMonitor(event => this._onDidMonitor.fire(event)));
		this._register(engine.onDidChangePorts(ports => this.updatePorts(ports)));
		this.setTask({ kind: 'busy', what: localize('triage.arduino.starting', "Starting the Arduino engine (the first start sets up the AVR compiler)…") });
		try {
			const started = await engine.start(join(this.environmentService.appRoot, 'engines'), this.additionalUrls());
			this.logService.info(`[triage] Arduino engine: arduino-cli ${started.arduinoCli}, ${started.platform}, in ${started.home}`);
			this.setTask({ kind: 'idle' });
		} catch (error) {
			this.setTask({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		return engine;
	}

	private updatePorts(ports: readonly IArduinoPort[]): void {
		this._ports = ports;
		const saved = this.storageService.get(STORAGE_PORT, StorageScope.WORKSPACE);
		if (this._port && !ports.some(p => p.address === this._port?.address)) {
			// Unplugged.
			this._port = undefined;
		}
		if (!this._port) {
			const fqbn = this.fqbn?.split(':').slice(0, 3).join(':');
			this._port = ports.find(p => p.address === saved)
				?? ports.find(p => p.boards.some(b => fqbn && b.fqbn.startsWith(fqbn)))
				?? ports.find(p => p.boards.length > 0);
		}
		this.renderStatus();
		this._onDidChangePorts.fire(ports);
		this._onDidChangeSelection.fire();
	}

	// --- Build and Upload ---

	private projectRef(): IArduinoProjectRef | undefined {
		const state = this.projectService.state;
		if (state.kind !== 'project') {
			this.notificationService.info(localize('triage.arduino.noProject', "Open a Triage project first (File → Open Folder…, or File → New Project…)."));
			return undefined;
		}
		const code = state.project.domains.find(domain => domain.id === 'code');
		return {
			root: state.project.root,
			firmwareDir: join(state.project.root, code?.path ?? 'firmware'),
			board: state.project.board ?? 'arduino-uno',
			...(this.fqbn ? { fqbn: this.fqbn } : {}),
		};
	}

	async build(): Promise<IArduinoBuild | undefined> {
		const project = this.projectRef();
		if (!project) {
			return undefined;
		}
		this.setTask({ kind: 'busy', what: localize('triage.arduino.building', "Building the firmware for {0}…", this.boardName ?? project.board) });
		this._onDidOutput.fire({ task: 'build', text: `\n${localize('triage.arduino.buildStart', "Building {0} for {1}…", project.root, this.fqbn ?? project.board)}\n` });
		try {
			const engine = await this.engine();
			const result = await engine.build(project);
			this.showDiagnostics(result);
			this.setTask({ kind: 'idle' });
			const used = result.maxFlash ? ` (${Math.round(100 * result.flash / result.maxFlash)}%)` : '';
			this._onDidOutput.fire({ task: 'build', text: `${localize('triage.arduino.built', "Done: {0} bytes of flash{1}, {2} bytes of RAM. Libraries: {3}.", result.flash, used, result.ram, result.libraries.join(', ') || '—')}\n` });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setTask({ kind: 'error', message });
			this._onDidOutput.fire({ task: 'build', text: `${message}\n` });
			this.notificationService.notify({ severity: Severity.Error, message: localize('triage.arduino.buildFailed', "The firmware didn't build: {0}", message) });
			return undefined;
		}
	}

	private showDiagnostics(result: IArduinoBuild): void {
		const byFile = new Map<string, IMarkerData[]>();
		for (const d of result.diagnostics) {
			if (!d.file) {
				continue;
			}
			const list = byFile.get(d.file) ?? [];
			list.push({
				severity: d.severity === 'error' ? MarkerSeverity.Error : d.severity === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Info,
				message: d.message,
				startLineNumber: Math.max(1, d.line), startColumn: Math.max(1, d.column),
				endLineNumber: Math.max(1, d.line), endColumn: Math.max(1, d.column) + 1,
				source: 'arduino-cli',
			});
			byFile.set(d.file, list);
		}
		this.markerService.changeAll(BUILD_MARKERS, [...byFile].flatMap(([file, markers]) => markers.map(marker => ({ resource: URI.file(file), marker }))));
	}

	async upload(): Promise<boolean> {
		const project = this.projectRef();
		if (!project) {
			return false;
		}
		const port = this._port;
		if (!port) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('triage.arduino.noPort', "No board is plugged in, or none is picked. Plug the Arduino in with its USB cable, then pick it in the status bar (the board's name at the bottom left)."),
			});
			return false;
		}
		this.setTask({ kind: 'busy', what: localize('triage.arduino.uploading', "Uploading to {0} on {1}…", this.boardName ?? '', port.label) });
		this._onDidOutput.fire({ task: 'upload', text: `\n${localize('triage.arduino.uploadStart', "Uploading to {0} on {1}…", this.fqbn ?? project.board, port.label)}\n` });
		try {
			const engine = await this.engine();
			await engine.upload(project, port.address, port.protocol);
			this.setTask({ kind: 'idle' });
			this._onDidOutput.fire({ task: 'upload', text: `${localize('triage.arduino.uploaded', "Upload done: the board runs the new firmware.")}\n` });
			this.notificationService.info(localize('triage.arduino.uploadedNote', "Uploaded to {0} on {1}.", this.boardName ?? '', port.label));
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setTask({ kind: 'error', message });
			this._onDidOutput.fire({ task: 'upload', text: `${message}\n` });
			this.notificationService.notify({ severity: Severity.Error, message: localize('triage.arduino.uploadFailed', "Upload failed: {0}", message) });
			return false;
		}
	}
}
