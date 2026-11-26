/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Utility-process broker for the EDA engine (ROADMAP P1-2, PLAN §4.2). Runs
 *  triage-eda-engine under the P0-4 supervisor (restart with backoff), matches
 *  Response frames to requests by id, and hands each request its display-list
 *  chunks. Patch 0002 adds this module to the build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { readChunkHeader } from '../common/eda/displayList.js';
import { EDA_ENGINE_CHANNEL, EdaFrame, IEdaEngineBroker, IEdaReply, packReply } from '../common/eda/edaEngine.js';
import { peekId } from '../common/eda/protobuf.js';
import { EngineState, frameText, FrameType } from '../common/engineProtocol.js';
import { EngineSupervisor } from './engineSupervisor.js';

interface Pending {
	readonly resolve: (reply: IEdaReply) => void;
	readonly reject: (error: Error) => void;
	readonly chunks: Uint8Array[];
}

export class EdaEngineBroker implements IEdaEngineBroker {
	private readonly disposables = new DisposableStore();
	private readonly _onDidChangeState = this.disposables.add(new Emitter<EngineState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private supervisor: EngineSupervisor | undefined;
	private readonly pending = new Map<number, Pending>();
	private folder = '';
	private env: Record<string, string> = {};

	async start(folder: string): Promise<EngineState> {
		if (!this.supervisor) {
			const executable = join(folder, process.platform === 'win32' ? 'triage-eda-engine.exe' : 'triage-eda-engine');
			// The kifaces and KiCad's libraries sit beside the engine. Windows finds DLLs
			// there by itself; Linux needs the library path.
			const env: Record<string, string> = process.platform === 'win32'
				? { PATH: `${folder};${process.env['PATH'] ?? ''}` }
				: { LD_LIBRARY_PATH: `${folder}:${process.env['LD_LIBRARY_PATH'] ?? ''}` };
			this.folder = folder;
			this.env = env;
			this.supervisor = new EngineSupervisor({
				executable,
				name: 'eda',
				env,
				// Loading KiCad's settings and library tables takes a moment.
				helloTimeoutMs: 60_000,
			});
			this.supervisor.onState(state => {
				if (state.kind !== 'connected') {
					this.failPending(`EDA engine ${state.kind}`);
				}
				this._onDidChangeState.fire(state);
			});
			this.supervisor.onFrame(frame => this.onFrame(frame.type, frame.payload));
		}
		await this.supervisor.start();
		return this.supervisor.state;
	}

	async getState(): Promise<EngineState> {
		return this.supervisor?.state ?? { kind: 'stopped', reason: 'not started' };
	}

	async request(request: VSBuffer): Promise<VSBuffer> {
		return packReply(await this.send(request));
	}

	private send(request: VSBuffer): Promise<IEdaReply> {
		const supervisor = this.supervisor;
		if (!supervisor) {
			return Promise.reject(new Error('EDA engine not started'));
		}
		const id = peekId(request.buffer);
		return new Promise<IEdaReply>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, chunks: [] });
			const send = () => {
				try {
					supervisor.send(EdaFrame.Request, request.buffer);
				} catch (error) {
					this.pending.delete(id);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			};
			if (supervisor.state.kind === 'connected') {
				send();
			} else {
				// Restarting: wait for the engine to come back.
				supervisor.whenConnected().then(send, error => {
					this.pending.delete(id);
					reject(error);
				});
			}
		});
	}

	async kill(): Promise<void> {
		this.supervisor?.kill();
	}

	/**
	 * KiCad's stand-alone schematic or board editor, built from Triage's tree and
	 * shipped beside the engine, on the same file. It runs detached: closing it
	 * leaves Triage alone, and Triage reloads the file when it is saved.
	 */
	async openInKicad(path: string): Promise<void> {
		const editor = path.endsWith('.kicad_sch') ? 'eeschema' : path.endsWith('.kicad_pcb') ? 'pcbnew' : undefined;
		if (!editor) {
			throw new Error(`KiCad opens .kicad_sch and .kicad_pcb files, not ${path}`);
		}
		const executable = join(this.folder, process.platform === 'win32' ? `${editor}.exe` : editor);
		if (!existsSync(executable)) {
			throw new Error(`KiCad's ${editor} is not in ${this.folder}`);
		}
		const child = spawn(executable, [path], {
			detached: true,
			stdio: 'ignore',
			env: { ...process.env, ...this.env },
		});
		child.unref();
	}

	private onFrame(type: number, payload: Uint8Array): void {
		if (type === EdaFrame.DisplayList) {
			const pending = this.pending.get(readChunkHeader(payload).requestId);
			// Copy: the frame's bytes belong to the socket's buffer.
			pending?.chunks.push(payload.slice());
		} else if (type === EdaFrame.Response) {
			const id = peekId(payload);
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				pending.resolve({ response: payload.slice(), chunks: pending.chunks });
			}
		} else if (type === FrameType.Error) {
			this.failPending(`EDA engine error: ${frameText({ type, payload })}`);
		}
	}

	private failPending(reason: string): void {
		for (const pending of this.pending.values()) {
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}

if (isUtilityProcess(process)) {
	const server = new UtilityProcessServer();
	server.registerChannel(EDA_ENGINE_CHANNEL, ProxyChannel.fromService(new EdaEngineBroker(), new DisposableStore()));
}
