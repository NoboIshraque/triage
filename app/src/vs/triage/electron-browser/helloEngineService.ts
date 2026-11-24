/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The window's side of the hello engine (ROADMAP P0-4): starts the broker in a
 *  utility process on first use, mirrors the engine state into the status bar,
 *  and measures throughput all the way into this window.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { isWindows } from '../../base/common/platform.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { localize } from '../../nls.js';
import { ILogService } from '../../platform/log/common/log.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../workbench/services/statusbar/browser/statusbar.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { EngineState } from '../common/engineProtocol.js';
import { describeEngineState, HELLO_ENGINE_BROKER_MODULE, HELLO_ENGINE_CHANNEL, HELLO_ENGINE_COMMANDS, HELLO_ENGINE_STATUS_ID, IHelloEngineBenchmark, IHelloEngineBroker, ITriageHelloEngineService } from '../common/helloEngine.js';

const BENCHMARK_FRAMES = 256;
const BENCHMARK_FRAME_SIZE = 1 << 20;

export class TriageHelloEngineService extends Disposable implements ITriageHelloEngineService {
	declare readonly _serviceBrand: undefined;

	private _state: EngineState = { kind: 'stopped', reason: 'not started' };
	private readonly _onDidChangeState = this._register(new Emitter<EngineState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _lastBenchmark: IHelloEngineBenchmark | undefined;
	private readonly _onDidBenchmark = this._register(new Emitter<IHelloEngineBenchmark>());
	readonly onDidBenchmark = this._onDidBenchmark.event;

	private broker: Promise<IHelloEngineBroker> | undefined;
	private readonly worker = this._register(new MutableDisposable());
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

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

	get lastBenchmark(): IHelloEngineBenchmark | undefined {
		return this._lastBenchmark;
	}

	async start(): Promise<void> {
		await this.getBroker();
	}

	async kill(): Promise<void> {
		await (await this.getBroker()).kill();
	}

	async benchmark(): Promise<IHelloEngineBenchmark> {
		const broker = await this.getBroker();
		const total = BENCHMARK_FRAMES * BENCHMARK_FRAME_SIZE;
		await broker.streamToBroker(8, BENCHMARK_FRAME_SIZE); // warm-up
		const toBroker = await broker.streamToBroker(BENCHMARK_FRAMES, BENCHMARK_FRAME_SIZE);

		let received = 0;
		let finished: (time: number) => void = () => { };
		const arrived = new Promise<number>(resolve => finished = resolve);
		const listener = broker.onDidReceiveData(buffer => {
			received += buffer.byteLength;
			if (received >= total) {
				finished(performance.now());
			}
		});
		try {
			const started = performance.now();
			await broker.streamToRenderer(BENCHMARK_FRAMES, BENCHMARK_FRAME_SIZE);
			const ended = await arrived;
			const result: IHelloEngineBenchmark = {
				toWindow: Math.round(received / 1e6 / ((ended - started) / 1000)),
				toBroker: Math.round(toBroker.megabytesPerSecond),
				mebibytes: total / 2 ** 20,
				frameSize: BENCHMARK_FRAME_SIZE,
			};
			this._lastBenchmark = result;
			this._onDidBenchmark.fire(result);
			this.logService.info(`[triage] hello engine benchmark: ${JSON.stringify(result)}`);
			return result;
		} finally {
			listener.dispose();
		}
	}

	private getBroker(): Promise<IHelloEngineBroker> {
		if (!this.broker) {
			this.broker = this.createBroker();
			this.broker.catch(error => {
				this.broker = undefined;
				this.setState({ kind: 'stopped', reason: String(error) });
			});
		}
		return this.broker;
	}

	private async createBroker(): Promise<IHelloEngineBroker> {
		this.setState({ kind: 'starting' });
		const worker = await this.workerService.createWorker({
			moduleId: HELLO_ENGINE_BROKER_MODULE,
			type: 'triageHelloEngine',
			name: 'triage-hello-engine-broker',
		});
		this.worker.value = worker;
		void worker.onDidTerminate.then(() => {
			if (this.worker.value === worker) {
				this.broker = undefined;
				this.setState({ kind: 'stopped', reason: 'broker exited' });
			}
		});

		const broker = ProxyChannel.toService<IHelloEngineBroker>(worker.client.getChannel(HELLO_ENGINE_CHANNEL));
		this._register(broker.onDidChangeState(state => this.setState(state)));
		const executable = join(this.environmentService.appRoot, 'engines', isWindows ? 'triage-hello-engine.exe' : 'triage-hello-engine');
		this.setState(await broker.start(executable));
		return broker;
	}

	private setState(state: EngineState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
		const icon = state.kind === 'connected' ? '$(circuit-board)' : state.kind === 'stopped' ? '$(error)' : '$(sync~spin)';
		const text = localize('triage.helloEngine.status', "{0} Hello engine: {1}", icon, state.kind);
		const entry = {
			name: localize('triage.helloEngine.statusName', "Triage Hello Engine"),
			text,
			ariaLabel: text,
			tooltip: describeEngineState(state),
			command: HELLO_ENGINE_COMMANDS.benchmark,
		};
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, HELLO_ENGINE_STATUS_ID, StatusbarAlignment.LEFT, -100);
		}
	}
}
