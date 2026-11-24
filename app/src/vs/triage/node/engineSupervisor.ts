/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Runs one native engine process for its broker (ROADMAP P0-4, PLAN §4.2):
 *  listens on a local endpoint (Unix socket, or named pipe on Windows), starts
 *  the engine with `--connect <endpoint>`, reads its frames, and restarts it
 *  with backoff when it dies. No VS Code imports: tested in app/engine-tests.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { unlink } from 'fs/promises';
import { createServer, Server, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { encodeFrame, encodeStreamRequest, Frame, FrameDecoder, frameText, FrameType, parseHello, readU64 } from '../common/engineProtocol.js';

export type EngineState =
	| { readonly kind: 'starting' }
	| { readonly kind: 'connected'; readonly pid: number; readonly version: string; readonly restarts: number }
	| { readonly kind: 'reconnecting'; readonly attempt: number; readonly reason: string; readonly restarts: number }
	| { readonly kind: 'stopped'; readonly reason: string };

export interface EngineSupervisorOptions {
	/** Path of the engine executable. */
	readonly executable: string;
	/** Short name for the endpoint and messages, e.g. "hello". */
	readonly name: string;
	/** Waits before each restart attempt; the last value repeats. */
	readonly restartDelaysMs?: readonly number[];
	/** How long a started engine may take to say Hello. */
	readonly helloTimeoutMs?: number;
}

export interface StreamResult {
	readonly bytes: number;
	readonly frames: number;
	readonly milliseconds: number;
	readonly megabytesPerSecond: number;
}

type Listener<T> = (value: T) => void;

/** A local endpoint name that is valid on this platform. */
export function makeEndpoint(name: string): string {
	const id = `triage-${name}-${process.pid}-${randomBytes(4).toString('hex')}`;
	return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

export class EngineSupervisor {
	private readonly stateListeners = new Set<Listener<EngineState>>();
	private readonly frameListeners = new Set<Listener<Frame>>();
	private readonly restartDelays: readonly number[];
	private readonly helloTimeoutMs: number;
	private readonly endpoint: string;

	private server: Server | undefined;
	private child: ChildProcess | undefined;
	private socket: Socket | undefined;
	private helloTimer: ReturnType<typeof setTimeout> | undefined;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private attempt = 0;
	private restarts = 0;
	private stopping = false;
	private _state: EngineState = { kind: 'stopped', reason: 'not started' };

	constructor(private readonly options: EngineSupervisorOptions) {
		this.restartDelays = options.restartDelaysMs ?? [1000, 2000, 5000];
		this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
		this.endpoint = makeEndpoint(options.name);
	}

	get state(): EngineState {
		return this._state;
	}

	onState(listener: Listener<EngineState>): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	onFrame(listener: Listener<Frame>): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	/** Starts listening and launches the engine. Resolves once it says Hello. */
	async start(): Promise<void> {
		if (this.server) {
			return this.whenConnected();
		}
		this.stopping = false;
		const server = createServer(socket => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.endpoint, () => {
				server.off('error', reject);
				resolve();
			});
		});
		this.setState({ kind: 'starting' });
		this.launch();
		return this.whenConnected();
	}

	/** Resolves when the engine is (or becomes) connected; rejects if it stops. */
	whenConnected(): Promise<void> {
		if (this._state.kind === 'connected') {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const dispose = this.onState(state => {
				if (state.kind === 'connected') {
					dispose();
					resolve();
				} else if (state.kind === 'stopped') {
					dispose();
					reject(new Error(`${this.options.name} engine stopped: ${state.reason}`));
				}
			});
		});
	}

	send(type: number, payload?: Uint8Array): void {
		if (!this.socket || this._state.kind !== 'connected') {
			throw new Error(`${this.options.name} engine is not connected`);
		}
		this.socket.write(encodeFrame(type, payload));
	}

	/** Round trip of a Ping; resolves with the time in milliseconds. */
	async ping(): Promise<number> {
		const started = performance.now();
		const token = randomBytes(8);
		await new Promise<void>((resolve, reject) => {
			const dispose = this.onFrame(frame => {
				if (frame.type === FrameType.Pong && Buffer.from(frame.payload).equals(token)) {
					dispose();
					resolve();
				}
			});
			try {
				this.send(FrameType.Ping, token);
			} catch (error) {
				dispose();
				reject(error);
			}
		});
		return performance.now() - started;
	}

	/**
	 * Asks the engine for `frames` Data frames of `frameSize` bytes and measures
	 * how fast they arrive here. `onData` sees every frame (the broker forwards
	 * them to the renderer).
	 */
	stream(frames: number, frameSize: number, onData?: (payload: Uint8Array) => void): Promise<StreamResult> {
		return new Promise((resolve, reject) => {
			let bytes = 0;
			let received = 0;
			const started = performance.now();
			const disposeFrames = this.onFrame(frame => {
				if (frame.type === FrameType.Data) {
					bytes += frame.payload.byteLength;
					received++;
					onData?.(frame.payload);
				} else if (frame.type === FrameType.StreamEnd) {
					cleanup();
					const milliseconds = performance.now() - started;
					const sent = readU64(frame.payload);
					if (sent !== bytes) {
						reject(new Error(`engine sent ${sent} bytes, ${bytes} arrived`));
						return;
					}
					resolve({ bytes, frames: received, milliseconds, megabytesPerSecond: bytes / 1e6 / (milliseconds / 1000) });
				} else if (frame.type === FrameType.Error) {
					cleanup();
					reject(new Error(`engine error: ${frameText(frame)}`));
				}
			});
			const disposeState = this.onState(state => {
				if (state.kind !== 'connected') {
					cleanup();
					reject(new Error(`${this.options.name} engine disconnected during the stream`));
				}
			});
			const cleanup = () => {
				disposeFrames();
				disposeState();
			};
			if (!this.socket || this._state.kind !== 'connected') {
				cleanup();
				reject(new Error(`${this.options.name} engine is not connected`));
				return;
			}
			this.socket.write(encodeStreamRequest(frames, frameSize));
		});
	}

	/** Kills the engine process (to exercise restart handling). */
	kill(): void {
		this.child?.kill('SIGKILL');
	}

	/** Stops the engine and the endpoint; no restart. */
	async stop(): Promise<void> {
		this.stopping = true;
		clearTimeout(this.restartTimer);
		clearTimeout(this.helloTimer);
		this.socket?.destroy();
		this.child?.kill();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		if (process.platform !== 'win32') {
			await unlink(this.endpoint).catch(() => undefined);
		}
		this.setState({ kind: 'stopped', reason: 'stopped' });
	}

	private launch(): void {
		const child = spawn(this.options.executable, ['--connect', this.endpoint], {
			stdio: ['ignore', 'ignore', 'pipe'],
			windowsHide: true,
		});
		this.child = child;
		let stderr = '';
		child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
		child.once('error', error => this.lost(child, `could not start: ${error.message}`));
		child.once('exit', (code, signal) => this.lost(child, `exited (${signal ?? `code ${code}`})${stderr ? `: ${stderr.trim()}` : ''}`));
		this.helloTimer = setTimeout(() => {
			this.lost(child, `no Hello within ${this.helloTimeoutMs} ms`);
			child.kill('SIGKILL');
		}, this.helloTimeoutMs);
	}

	private accept(socket: Socket): void {
		if (this.socket) {
			socket.destroy(); // one engine connection at a time
			return;
		}
		this.socket = socket;
		const child = this.child;
		const decoder = new FrameDecoder();
		socket.on('data', (chunk: Buffer) => {
			let frames: Frame[];
			try {
				frames = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			} catch (error) {
				socket.destroy();
				if (child) {
					this.lost(child, `protocol error: ${(error as Error).message}`);
					child.kill('SIGKILL');
				}
				return;
			}
			for (const frame of frames) {
				if (frame.type === FrameType.Hello && this._state.kind !== 'connected') {
					this.connected(frameText(frame));
				}
				for (const listener of this.frameListeners) {
					listener(frame);
				}
			}
		});
		socket.on('error', () => { /* 'close' follows */ });
		socket.on('close', () => {
			if (this.socket === socket) {
				this.socket = undefined;
			}
			if (child) {
				this.lost(child, 'connection closed');
			}
		});
	}

	private connected(helloText: string): void {
		clearTimeout(this.helloTimer);
		const hello = parseHello(helloText);
		this.attempt = 0;
		this.setState({ kind: 'connected', pid: hello?.pid ?? this.child?.pid ?? -1, version: hello?.version ?? '?', restarts: this.restarts });
	}

	/** The engine process `child` is gone or unusable: restart unless stopping. */
	private lost(child: ChildProcess, reason: string): void {
		if (child !== this.child) {
			return; // an older process; already handled
		}
		this.child = undefined;
		clearTimeout(this.helloTimer);
		this.socket?.destroy();
		this.socket = undefined;
		if (this.stopping) {
			return;
		}
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
		const delay = this.restartDelays[Math.min(this.attempt, this.restartDelays.length - 1)] ?? 1000;
		this.attempt++;
		this.restarts++;
		this.setState({ kind: 'reconnecting', attempt: this.attempt, reason, restarts: this.restarts });
		this.restartTimer = setTimeout(() => {
			if (!this.stopping) {
				this.launch();
			}
		}, delay);
	}

	private setState(state: EngineState): void {
		this._state = state;
		for (const listener of [...this.stateListeners]) {
			listener(state);
		}
	}
}
