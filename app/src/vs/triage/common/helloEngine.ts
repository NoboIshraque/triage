/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The hello engine (ROADMAP P0-4): the pattern every Triage engine follows.
 *  Renderer -> MessagePort -> broker (utility process) -> local socket -> native engine.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../base/common/buffer.js';
import { Event } from '../../base/common/event.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { EngineState, StreamResult } from './engineProtocol.js';

export const HELLO_ENGINE_CHANNEL = 'triageHelloEngine';
export const HELLO_ENGINE_BROKER_MODULE = 'vs/triage/node/helloEngineBrokerMain';
export const HELLO_ENGINE_STATUS_ID = 'triage.helloEngine';

export const HELLO_ENGINE_COMMANDS = {
	start: 'triage.helloEngine.start',
	benchmark: 'triage.helloEngine.benchmark',
	kill: 'triage.helloEngine.kill',
} as const;

/** The broker's side of the MessagePort channel (runs in the utility process). */
export interface IHelloEngineBroker {
	readonly onDidChangeState: Event<EngineState>;
	/** Data frames forwarded during `streamToRenderer`. */
	readonly onDidReceiveData: Event<VSBuffer>;
	start(executable: string): Promise<EngineState>;
	getState(): Promise<EngineState>;
	ping(): Promise<number>;
	/** Engine -> broker only. */
	streamToBroker(frames: number, frameSize: number): Promise<StreamResult>;
	/** Engine -> broker -> renderer: every Data frame is also sent as onDidReceiveData. */
	streamToRenderer(frames: number, frameSize: number): Promise<StreamResult>;
	kill(): Promise<void>;
}

export interface IHelloEngineBenchmark {
	/** Megabytes per second that reached the window (engine -> broker -> renderer). */
	readonly toWindow: number;
	/** Megabytes per second that reached the broker (engine -> broker). */
	readonly toBroker: number;
	readonly mebibytes: number;
	readonly frameSize: number;
}

export const ITriageHelloEngineService = createDecorator<ITriageHelloEngineService>('triageHelloEngineService');

/** The window's view of the hello engine. Starts it lazily. */
export interface ITriageHelloEngineService {
	readonly _serviceBrand: undefined;
	readonly state: EngineState;
	readonly onDidChangeState: Event<EngineState>;
	readonly lastBenchmark: IHelloEngineBenchmark | undefined;
	readonly onDidBenchmark: Event<IHelloEngineBenchmark>;
	start(): Promise<void>;
	benchmark(): Promise<IHelloEngineBenchmark>;
	kill(): Promise<void>;
}

export function describeEngineState(state: EngineState): string {
	switch (state.kind) {
		case 'starting': return 'starting';
		case 'connected': return `connected (pid ${state.pid}, restarts ${state.restarts})`;
		case 'reconnecting': return `reconnecting (attempt ${state.attempt}: ${state.reason})`;
		case 'stopped': return `stopped (${state.reason})`;
	}
}
