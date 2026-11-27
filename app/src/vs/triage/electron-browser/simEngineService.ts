/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The window's side of the simulation (ROADMAP P3): starts the sim engine in a
 *  utility process on first use, loads the open project, and passes the engine's
 *  state and frames on to the Sim and 3D tabs. Shows the run in the status bar.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { localize } from '../../nls.js';
import { ILogService } from '../../platform/log/common/log.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../workbench/services/statusbar/browser/statusbar.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { ITriageProjectService } from '../common/projectModel.js';
import { ISimEngine, ISimFrame, ISimScenarioResult, ISimScope, ITriageSimService, SIM_ENGINE_CHANNEL, SIM_ENGINE_FOLDER, SIM_ENGINE_MODULE, SIM_ENGINE_STATUS_ID, SimState } from '../common/sim/simService.js';

export class TriageSimService extends Disposable implements ITriageSimService {
	declare readonly _serviceBrand: undefined;

	private _state: SimState = { kind: 'idle' };
	private readonly _onDidChangeState = this._register(new Emitter<SimState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidFrame = this._register(new Emitter<ISimFrame>());
	readonly onDidFrame = this._onDidFrame.event;
	private _lastFrame: ISimFrame | undefined;

	private engine: Promise<ISimEngine> | undefined;
	private loaded: Promise<{ scopes: readonly ISimScope[]; scenarios: readonly string[]; mujoco: boolean }> | undefined;
	private loadedRoot: string | undefined;
	private readonly worker = this._register(new MutableDisposable());
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly workerService: IUtilityProcessWorkerWorkbenchService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITriageProjectService private readonly projectService: ITriageProjectService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.projectService.onDidChangeState(() => {
			const root = this.projectService.state.kind === 'project' ? this.projectService.state.project.root : undefined;
			if (root !== this.loadedRoot) {
				this.loaded = undefined;
			}
		}));
	}

	get state(): SimState {
		return this._state;
	}

	get lastFrame(): ISimFrame | undefined {
		return this._lastFrame;
	}

	private getEngine(): Promise<ISimEngine> {
		if (!this.engine) {
			this.engine = this.createEngine();
			this.engine.catch(error => {
				this.engine = undefined;
				this.setState({ kind: 'error', message: String(error) });
			});
		}
		return this.engine;
	}

	private async createEngine(): Promise<ISimEngine> {
		const worker = await this.workerService.createWorker({
			moduleId: SIM_ENGINE_MODULE,
			type: 'triageSimEngine',
			name: 'triage-sim-engine',
		});
		this.worker.value = worker;
		void worker.onDidTerminate.then(() => {
			if (this.worker.value === worker) {
				this.engine = undefined;
				this.loaded = undefined;
				this.setState({ kind: 'error', message: localize('triage.sim.exited', "The simulation engine stopped. Run again to restart it.") });
			}
		});
		const engine = ProxyChannel.toService<ISimEngine>(worker.client.getChannel(SIM_ENGINE_CHANNEL));
		this._register(engine.onDidChangeState(state => this.setState(state)));
		this._register(engine.onDidFrame(frame => {
			this._lastFrame = frame;
			this._onDidFrame.fire(frame);
			this.updateStatus();
		}));
		return engine;
	}

	load(): Promise<{ scopes: readonly ISimScope[]; scenarios: readonly string[]; mujoco: boolean }> {
		const state = this.projectService.state;
		if (state.kind !== 'project') {
			return Promise.reject(new Error(localize('triage.sim.noProject', "Open a Triage project (a folder with a triage.toml) to simulate it.")));
		}
		if (!this.loaded || this.loadedRoot !== state.project.root) {
			this.loadedRoot = state.project.root;
			const folder = join(this.environmentService.appRoot, 'engines', SIM_ENGINE_FOLDER);
			this.loaded = this.getEngine().then(engine => engine.load(folder, state.project.root));
			this.loaded.catch(error => {
				this.loaded = undefined;
				this.logService.warn('[triage] simulation: the project did not load', error);
			});
		}
		return this.loaded;
	}

	async prepare(scope: string): Promise<SimState> {
		await this.load();
		this._lastFrame = undefined;
		return (await this.getEngine()).prepare(scope);
	}

	async run(speed = 1): Promise<void> {
		await (await this.getEngine()).run(speed);
	}

	async pause(): Promise<void> {
		await (await this.getEngine()).pause();
	}

	async step(seconds: number): Promise<void> {
		await (await this.getEngine()).step(seconds);
	}

	async stop(): Promise<void> {
		if (this.engine) {
			await (await this.engine).stop();
		}
	}

	async setSpeed(speed: number): Promise<void> {
		await (await this.getEngine()).setSpeed(speed);
	}

	async input(control: string, value: number): Promise<void> {
		await (await this.getEngine()).input(control, value);
	}

	async release(control: string, value: number): Promise<void> {
		await (await this.getEngine()).release(control, value);
	}

	async sendSerial(text: string): Promise<void> {
		await (await this.getEngine()).sendSerial(text);
	}

	async runScenarios(files: readonly string[]): Promise<ISimScenarioResult[]> {
		await this.load();
		return (await this.getEngine()).runScenarios(files);
	}

	private setState(state: SimState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
		this.updateStatus();
	}

	private updateStatus(): void {
		const state = this._state;
		if (state.kind === 'idle') {
			this.statusEntry.clear();
			return;
		}
		const frame = this._lastFrame;
		const time = frame ? `${frame.t.toFixed(2)} s` : '';
		const text = state.kind === 'running'
			? localize('triage.sim.status.running', "$(debug-start) Sim: {0} · {1} · {2}× real time", state.info.scope, time, frame ? frame.ratio.toFixed(2) : '–')
			: state.kind === 'paused'
				? localize('triage.sim.status.paused', "$(debug-pause) Sim: {0} · paused at {1}", state.info.scope, time)
				: state.kind === 'ready'
					? localize('triage.sim.status.ready', "$(play) Sim: {0} · ready", state.info.scope)
					: state.kind === 'building'
						? localize('triage.sim.status.building', "$(sync~spin) Sim: building the {0}", state.what)
						: localize('triage.sim.status.error', "$(error) Sim: {0}", state.message.split('\n')[0].slice(0, 80));
		const entry = { name: localize('triage.sim.statusName', "Triage Simulation"), text, ariaLabel: text, command: 'triage.sim.focus' };
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, SIM_ENGINE_STATUS_ID, StatusbarAlignment.LEFT, -103);
		}
	}
}
