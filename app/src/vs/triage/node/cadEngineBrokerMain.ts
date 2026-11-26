/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Utility-process broker for the CAD engine (ROADMAP P2-2, P2-3, PLAN §4.2). Runs
 *  FreeCADCmd with Triage's engine host under the P0-4 supervisor (restart with
 *  backoff), matches JSON-RPC responses to requests by id, and hands each request
 *  the mesh frames streamed before its response. Patch 0002 adds this module to the
 *  build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync } from 'fs';
import { join } from 'path';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { CadFrame, decodeResponse, meshRequestId } from '../common/cad/cadEngine.js';
import { CAD_ENGINE_CHANNEL, ICadEngineBroker } from '../common/cad/cadEngineService.js';
import { packReply } from '../common/eda/edaEngine.js';
import { EngineState, frameText, FrameType } from '../common/engineProtocol.js';
import { EngineSupervisor } from './engineSupervisor.js';

interface Pending {
	readonly resolve: (reply: VSBuffer) => void;
	readonly reject: (error: Error) => void;
	readonly meshes: Uint8Array[];
}

const decoder = new TextDecoder();

/** The request id of a JSON-RPC request, without decoding it all. */
function requestId(request: Uint8Array): number {
	const id = (JSON.parse(decoder.decode(request)) as { id?: unknown }).id;
	if (typeof id !== 'number') {
		throw new Error('a CAD engine request needs a numeric id');
	}
	return id;
}

export class CadEngineBroker implements ICadEngineBroker {
	private readonly disposables = new DisposableStore();
	private readonly _onDidChangeState = this.disposables.add(new Emitter<EngineState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private supervisor: EngineSupervisor | undefined;
	private readonly pending = new Map<number, Pending>();

	async start(folder: string, userHome: string): Promise<EngineState> {
		if (!this.supervisor) {
			const windows = process.platform === 'win32';
			const bin = join(folder, 'bin');
			mkdirSync(userHome, { recursive: true });
			this.supervisor = new EngineSupervisor({
				executable: join(bin, windows ? 'FreeCADCmd.exe' : 'FreeCADCmd'),
				name: 'cad',
				// FreeCAD runs the script and hands it everything after --pass.
				args: [join(folder, 'triage', 'triage_cad_engine.py'), '--pass'],
				env: {
					FREECAD_USER_HOME: userHome,
					// The LibPack's DLLs sit beside FreeCADCmd on Windows.
					...(windows ? { PATH: `${bin};${process.env['PATH'] ?? ''}` } : {}),
				},
				// Python and FreeCAD's modules take a moment to load.
				helloTimeoutMs: 60_000,
			});
			this.supervisor.onState(state => {
				if (state.kind !== 'connected') {
					this.failPending(`CAD engine ${state.kind}`);
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

	request(request: VSBuffer): Promise<VSBuffer> {
		const supervisor = this.supervisor;
		if (!supervisor) {
			return Promise.reject(new Error('CAD engine not started'));
		}
		let id: number;
		try {
			id = requestId(request.buffer);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return new Promise<VSBuffer>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, meshes: [] });
			const send = () => {
				try {
					supervisor.send(CadFrame.Request, request.buffer);
				} catch (error) {
					this.pending.delete(id);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			};
			if (supervisor.state.kind === 'connected') {
				send();
			} else {
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

	private onFrame(type: number, payload: Uint8Array): void {
		if (type === CadFrame.Mesh) {
			// Copy: the frame's bytes belong to the socket's buffer.
			this.pending.get(meshRequestId(payload))?.meshes.push(payload.slice());
		} else if (type === CadFrame.Response) {
			const id = decodeResponse(payload).id ?? -1;
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				pending.resolve(packReply({ response: payload.slice(), chunks: pending.meshes }));
			}
		} else if (type === FrameType.Error) {
			this.failPending(`CAD engine error: ${frameText({ type, payload })}`);
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
	server.registerChannel(CAD_ENGINE_CHANNEL, ProxyChannel.fromService(new CadEngineBroker(), new DisposableStore()));
}
