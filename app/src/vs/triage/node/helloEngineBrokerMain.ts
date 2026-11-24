/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Utility-process broker for the hello engine (ROADMAP P0-4, PLAN §4.2). The
 *  window starts it through IUtilityProcessWorkerWorkbenchService and talks to
 *  it over a MessagePort; it talks to the native engine over a local socket.
 *  Patch 0002 adds this module to the build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { EngineState, StreamResult } from '../common/engineProtocol.js';
import { HELLO_ENGINE_CHANNEL, IHelloEngineBroker } from '../common/helloEngine.js';
import { EngineSupervisor } from './engineSupervisor.js';

class HelloEngineBroker implements IHelloEngineBroker {
	private readonly disposables = new DisposableStore();
	private readonly _onDidChangeState = this.disposables.add(new Emitter<EngineState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onDidReceiveData = this.disposables.add(new Emitter<VSBuffer>());
	readonly onDidReceiveData = this._onDidReceiveData.event;

	private supervisor: EngineSupervisor | undefined;

	async start(executable: string): Promise<EngineState> {
		if (!this.supervisor) {
			this.supervisor = new EngineSupervisor({ executable, name: 'hello' });
			this.supervisor.onState(state => this._onDidChangeState.fire(state));
		}
		await this.supervisor.start();
		return this.supervisor.state;
	}

	async getState(): Promise<EngineState> {
		return this.supervisor?.state ?? { kind: 'stopped', reason: 'not started' };
	}

	ping(): Promise<number> {
		return this.connected().ping();
	}

	streamToBroker(frames: number, frameSize: number): Promise<StreamResult> {
		return this.connected().stream(frames, frameSize);
	}

	streamToRenderer(frames: number, frameSize: number): Promise<StreamResult> {
		return this.connected().stream(frames, frameSize, payload => this._onDidReceiveData.fire(VSBuffer.wrap(payload)));
	}

	async kill(): Promise<void> {
		this.supervisor?.kill();
	}

	private connected(): EngineSupervisor {
		if (!this.supervisor) {
			throw new Error('hello engine not started');
		}
		return this.supervisor;
	}
}

if (!isUtilityProcess(process)) {
	throw new Error('helloEngineBrokerMain must run in a utility process');
}

const server = new UtilityProcessServer();
server.registerChannel(HELLO_ENGINE_CHANNEL, ProxyChannel.fromService(new HelloEngineBroker(), new DisposableStore()));
