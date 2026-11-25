/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The window's side of the EDA engine (ROADMAP P1-2): starts the broker in a
 *  utility process on the first request, encodes and decodes triage.eda.v1
 *  messages, and shows the engine's state in the status bar.
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
import * as api from '../common/eda/engineApi.generated.js';
import { EDA_ENGINE_BROKER_MODULE, EDA_ENGINE_CHANNEL, EDA_ENGINE_FOLDER, EDA_ENGINE_STATUS_ID, EdaEngineError, IEdaEngineBroker, IEdaResult, ITriageEdaEngineService } from '../common/eda/edaEngine.js';
import { decodeMessage, encodeMessage, Message } from '../common/eda/protobuf.js';
import { EngineState } from '../common/engineProtocol.js';
import { describeEngineState } from '../common/helloEngine.js';

export class TriageEdaEngineService extends Disposable implements ITriageEdaEngineService {
	declare readonly _serviceBrand: undefined;

	private _state: EngineState = { kind: 'stopped', reason: 'not started' };
	private readonly _onDidChangeState = this._register(new Emitter<EngineState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidRestart = this._register(new Emitter<void>());
	readonly onDidRestart = this._onDidRestart.event;

	private broker: Promise<IEdaEngineBroker> | undefined;
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

	async call(command: string, body: Message): Promise<IEdaResult> {
		const broker = await this.getBroker();
		const id = this.nextId++;
		const request = encodeMessage(api.Request, { id, [command]: body });
		const started = performance.now();
		const reply = await broker.request(VSBuffer.wrap(request));
		const response = decodeMessage(api.Response, reply.response.buffer);
		this.logService.trace(`[triage] eda ${command}: ${(performance.now() - started).toFixed(1)} ms, ${reply.chunks.length} chunk(s)`);
		if (!response.ok) {
			throw new EdaEngineError(response.error || `${command} failed`);
		}
		return { response, chunks: reply.chunks.map(chunk => chunk.buffer) };
	}

	async kill(): Promise<void> {
		await (await this.getBroker()).kill();
	}

	async openInKicad(path: string): Promise<void> {
		await (await this.getBroker()).openInKicad(path);
	}

	private getBroker(): Promise<IEdaEngineBroker> {
		if (!this.broker) {
			this.broker = this.createBroker();
			this.broker.catch(error => {
				this.broker = undefined;
				this.setState({ kind: 'stopped', reason: String(error) });
			});
		}
		return this.broker;
	}

	private async createBroker(): Promise<IEdaEngineBroker> {
		this.setState({ kind: 'starting' });
		const worker = await this.workerService.createWorker({
			moduleId: EDA_ENGINE_BROKER_MODULE,
			type: 'triageEdaEngine',
			name: 'triage-eda-engine-broker',
		});
		this.worker.value = worker;
		void worker.onDidTerminate.then(() => {
			if (this.worker.value === worker) {
				this.broker = undefined;
				this.setState({ kind: 'stopped', reason: 'broker exited' });
				this._onDidRestart.fire();
			}
		});

		const broker = ProxyChannel.toService<IEdaEngineBroker>(worker.client.getChannel(EDA_ENGINE_CHANNEL));
		this._register(broker.onDidChangeState(state => this.setState(state)));
		const folder = join(this.environmentService.appRoot, 'engines', EDA_ENGINE_FOLDER);
		this.setState(await broker.start(folder));
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
		const icon = state.kind === 'connected' ? '$(circuit-board)' : state.kind === 'stopped' ? '$(error)' : '$(sync~spin)';
		const label = state.kind === 'reconnecting' ? localize('triage.edaEngine.reconnecting', "reconnecting") : state.kind;
		const text = localize('triage.edaEngine.status', "{0} KiCad engine: {1}", icon, label);
		const entry = {
			name: localize('triage.edaEngine.statusName', "Triage KiCad Engine"),
			text,
			ariaLabel: text,
			tooltip: describeEngineState(state),
		};
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, EDA_ENGINE_STATUS_ID, StatusbarAlignment.LEFT, -101);
		}
	}
}
