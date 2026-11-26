// A small client for the staged CAD engine (ROADMAP P2-2), for scripts and harnesses
// outside the app: it listens on a local endpoint, starts FreeCADCmd with Triage's
// engine host, waits for Hello, and sends JSON-RPC requests in P0-4 frames. The app
// itself goes through the P0-4 supervisor (app/src/vs/triage/node/cadEngineBrokerMain.ts).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { engineScript, stagedEnv, stagedProgram } from '../stage.mjs';

const REQUEST = 0x30;
const RESPONSE = 0x31;
const MESH = 0x32;
const HELLO = 0x01;

export async function startEngine() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'triage-cad-client-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\triage-cad-client-${process.pid}`
      : path.join(work, 'engine.sock');
  const frames = [];
  const waiters = [];
  let socket;
  let buffer = Buffer.alloc(0);
  const server = net.createServer((connection) => {
    socket = connection;
    connection.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) break;
        frames.push({ type: buffer[4], payload: buffer.subarray(5, 4 + length) });
        buffer = buffer.subarray(4 + length);
      }
      waiters.splice(0).forEach((wake) => wake());
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  const child = spawn(
    stagedProgram('FreeCADCmd'),
    [engineScript, '--pass', '--connect', endpoint],
    {
      env: { ...process.env, ...stagedEnv(path.join(work, 'home')) },
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    },
  );
  const next = async () => {
    while (frames.length === 0) await new Promise((resolve) => waiters.push(resolve));
    return frames.shift();
  };
  const hello = await next();
  if (hello.type !== HELLO) throw new Error(`expected Hello, got frame ${hello.type}`);
  let nextId = 1;
  return {
    hello: hello.payload.toString('utf8'),
    /** Calls a method; resolves with { result, meshes } (raw mesh frame payloads). */
    async call(method, params) {
      const id = nextId++;
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const header = Buffer.alloc(5);
      header.writeUInt32LE(body.length + 1, 0);
      header[4] = REQUEST;
      socket.write(Buffer.concat([header, body]));
      const meshes = [];
      for (;;) {
        const frame = await next();
        if (frame.type === MESH) meshes.push(Buffer.from(frame.payload));
        else if (frame.type === RESPONSE) {
          const response = JSON.parse(frame.payload.toString('utf8'));
          if (response.error) throw new Error(`${method}: ${response.error.message}`);
          return { result: response.result, meshes };
        }
      }
    },
    async stop() {
      socket?.end();
      await new Promise((resolve) => child.once('exit', resolve));
      server.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}
