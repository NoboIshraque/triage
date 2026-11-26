/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The window's side of the CAD engine (ROADMAP P2-2, P2-3): starts the broker in a
 *  utility process on the first call, sends JSON-RPC requests, reads the meshes that
 *  come with their answers, and shows the engine's state in the status bar.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { localize } from '../../nls.js';
import { ILogService } from '../../platform/log/common/log.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../workbench/services/statusbar/browser/statusbar.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { decodeResponse, encodeRequest, readMesh } from '../common/cad/cadEngine.js';
import { CAD_ENGINE_BROKER_MODULE, CAD_ENGINE_CHANNEL, CAD_ENGINE_FOLDER, CAD_ENGINE_STATUS_ID, CadEngineError, ICadEngineBroker, ICadResult, ITriageCadEngineService } from '../common/cad/cadEngineService.js';
import { unpackReply } from '../common/eda/edaEngine.js';
import { EngineState } from '../common/engineProtocol.js';
import { describeEngineState } from '../common/helloEngine.js';

export class TriageCadEngineService extends Disposable implements ITriageCadEngineService {
	declare readonly _serviceBrand: undefined;

	private _state: EngineState = { kind: 'stopped', reason: 'not started' };
	private readonly _onDidChangeState = this._register(new Emitter<EngineState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidRestart = this._register(new Emitter<void>());
	readonly onDidRestart = this._onDidRestart.event;

	private broker: Promise<ICadEngineBroker> | undefined;
	private readonly worker = this._register(new MutableDisposable());
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private nextId = 1;
	private wasConnected = false;

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly workerService: IUtilityProcessWorkerWorkbenchService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get state(): EngineState {
		return this._state;
	}

	async call<T>(method: string, params?: unknown): Promise<ICadResult<T>> {
		const broker = await this.getBroker();
		const id = this.nextId++;
		const started = performance.now();
		const reply = unpackReply((await broker.request(VSBuffer.wrap(encodeRequest(id, method, params)))).buffer);
		const response = decodeResponse<T>(reply.response);
		this.logService.trace(`[triage] cad ${method}: ${(performance.now() - started).toFixed(1)} ms, ${reply.chunks.length} mesh(es)`);
		if (response.error) {
			throw new CadEngineError(`${method}: ${response.error.message}`, response.error.code);
		}
		return { result: response.result as T, meshes: reply.chunks.map(readMesh) };
	}

	async kill(): Promise<void> {
		await (await this.getBroker()).kill();
	}

	private getBroker(): Promise<ICadEngineBroker> {
		if (!this.broker) {
			this.broker = this.createBroker();
			this.broker.catch(error => {
				this.broker = undefined;
				this.setState({ kind: 'stopped', reason: String(error) });
			});
		}
		return this.broker;
	}

	private async createBroker(): Promise<ICadEngineBroker> {
		this.setState({ kind: 'starting' });
		const worker = await this.workerService.createWorker({
			moduleId: CAD_ENGINE_BROKER_MODULE,
			type: 'triageCadEngine',
			name: 'triage-cad-engine-broker',
		});
		this.worker.value = worker;
		void worker.onDidTerminate.then(() => {
			if (this.worker.value === worker) {
				this.broker = undefined;
				this.setState({ kind: 'stopped', reason: 'broker exited' });
				this._onDidRestart.fire();
			}
		});

		const broker = ProxyChannel.toService<ICadEngineBroker>(worker.client.getChannel(CAD_ENGINE_CHANNEL));
		this._register(broker.onDidChangeState(state => this.setState(state)));
		const folder = join(this.environmentService.appRoot, 'engines', CAD_ENGINE_FOLDER);
		const userHome = join(this.environmentService.userDataPath, 'cad-engine');
		this.setState(await broker.start(folder, userHome));
		return broker;
	}

	private setState(state: EngineState): void {
		const restarted = state.kind === 'connected' && this.wasConnected && this._state.kind !== 'connected';
		if (state.kind === 'connected') {
			this.wasConnected = true;
		}
		this._state = state;
		this._onDidChangeState.fire(state);
		if (restarted) {
			this._onDidRestart.fire();
		}
		const icon = state.kind === 'connected' ? '$(package)' : state.kind === 'stopped' ? '$(error)' : '$(sync~spin)';
		const label = state.kind === 'reconnecting' ? localize('triage.cadEngine.reconnecting', "reconnecting") : state.kind;
		const text = localize('triage.cadEngine.status', "{0} FreeCAD engine: {1}", icon, label);
		const entry = {
			name: localize('triage.cadEngine.statusName', "Triage FreeCAD Engine"),
			text,
			ariaLabel: text,
			tooltip: describeEngineState(state),
		};
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, CAD_ENGINE_STATUS_ID, StatusbarAlignment.LEFT, -102);
		}
	}
}
