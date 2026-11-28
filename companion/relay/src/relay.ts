// The phone companion's relay (ROADMAP PC-7, ADR 0005 decision 3; the owner:
// "whichever is the most secure"). A phone and a laptop each open a WebSocket to
// `/v1/<mailbox>?role=phone|laptop`; the relay forwards binary messages between
// the two peers of a mailbox and nothing else:
//
// - it holds no keys, no accounts and no content logs: every frame is sealed end
//   to end with the Noise keys the phone and the laptop agreed through the QR
//   code (crates/triage-companion), so it sees only ciphertext, sizes and timing;
// - mailboxes are 16 random bytes (32 hex digits), a pairing id or a paired
//   phone's mailbox, so they can't be guessed;
// - a mailbox holds one laptop and one phone; when either leaves, the other is
//   closed (the laptop then opens its mailbox again for the next session);
// - frames are size-, rate- and idle-limited, and connections per address too.
//
// It keeps nothing on disk and can restart at any time.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export interface RelayLimits {
  /** Largest message, bytes: one companion frame (a Noise message and its header). */
  readonly maxMessage: number;
  /** Messages per second per connection, sustained (twice in a burst). */
  readonly messagesPerSecond: number;
  /** Bytes per second per connection, sustained (twice in a burst). */
  readonly bytesPerSecond: number;
  /** A mailbox with no message either way for this long closes, ms. */
  readonly idleMs: number;
  /** A laptop waiting for a phone pings this often, ms (keeps NATs open). */
  readonly pingMs: number;
  /** Open connections per remote address. */
  readonly perAddress: number;
  /** Open mailboxes in all. */
  readonly mailboxes: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxMessage: 5 + 18 + 65_535,
  messagesPerSecond: 400,
  bytesPerSecond: 8 * 1024 * 1024,
  idleMs: 10 * 60_000,
  pingMs: 20_000,
  perAddress: 64,
  mailboxes: 20_000,
};

/** WebSocket close codes the relay sends (4000–4999 are the application's). */
export const CLOSE = {
  peerLeft: 4000,
  noLaptop: 4004,
  idle: 4008,
  taken: 4009,
  tooLarge: 4013,
  badRequest: 4400,
  tooMany: 4029,
} as const;

export interface RelayOptions {
  readonly limits?: Partial<RelayLimits>;
  /** Tests only: sees every forwarded message (the proof that only ciphertext passes). */
  readonly onForward?: (from: 'phone' | 'laptop', bytes: Uint8Array) => void;
  /** Behind a reverse proxy: take the client address from X-Forwarded-For. */
  readonly trustProxy?: boolean;
}

export interface RelayStats {
  mailboxes: number;
  connections: number;
  forwarded: number;
  bytes: number;
  refused: number;
}

interface Mailbox {
  laptop?: WebSocket | undefined;
  phone?: WebSocket | undefined;
  lastMessage: number;
}

class Bucket {
  private messages: number;
  private bytes: number;
  private at = Date.now();
  constructor(private readonly limits: RelayLimits) {
    this.messages = limits.messagesPerSecond * 2;
    this.bytes = limits.bytesPerSecond * 2;
  }
  take(size: number): boolean {
    const now = Date.now();
    const seconds = (now - this.at) / 1000;
    this.at = now;
    this.messages =
      Math.min(
        this.limits.messagesPerSecond * 2,
        this.messages + seconds * this.limits.messagesPerSecond,
      ) - 1;
    this.bytes =
      Math.min(this.limits.bytesPerSecond * 2, this.bytes + seconds * this.limits.bytesPerSecond) -
      size;
    return this.messages >= 0 && this.bytes >= 0;
  }
}

const MAILBOX = /^\/v1\/([0-9a-f]{32})$/;

export class Relay {
  readonly limits: RelayLimits;
  readonly stats: RelayStats = { mailboxes: 0, connections: 0, forwarded: 0, bytes: 0, refused: 0 };
  readonly server: Server;
  private readonly sockets: WebSocketServer;
  private readonly boxes = new Map<string, Mailbox>();
  private readonly perAddress = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: RelayOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.server = createServer((request, response) => {
      this.http(request, response);
    });
    this.sockets = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxMessage,
      perMessageDeflate: false,
    });
    this.server.on('upgrade', (request, socket, head) => {
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        this.accept(ws, request);
      });
    });
    this.timer = setInterval(
      () => {
        this.sweep();
      },
      Math.min(this.limits.pingMs, 5_000),
    );
    this.timer.unref();
  }

  private http(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    response
      .writeHead(404, { 'content-type': 'text/plain' })
      .end('Triage companion relay: WebSocket only.\n');
  }

  /** Listens on `port` (0 picks one); resolves with the port. */
  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    clearInterval(this.timer);
    for (const ws of this.sockets.clients) {
      ws.terminate();
    }
    return new Promise((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  private address(request: IncomingMessage): string {
    const forwarded = this.options.trustProxy ? request.headers['x-forwarded-for'] : undefined;
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first !== undefined && first !== ''
      ? first
      : (request.socket.remoteAddress ?? 'unknown');
  }

  private refuse(ws: WebSocket, code: number, reason: string): void {
    this.stats.refused++;
    ws.close(code, reason);
  }

  private accept(ws: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://relay');
    const match = MAILBOX.exec(url.pathname);
    const role = url.searchParams.get('role');
    if (!match || (role !== 'phone' && role !== 'laptop')) {
      this.refuse(ws, CLOSE.badRequest, 'expected /v1/<32 hex digits>?role=phone|laptop');
      return;
    }
    const address = this.address(request);
    const count = this.perAddress.get(address) ?? 0;
    if (count >= this.limits.perAddress) {
      this.refuse(ws, CLOSE.tooMany, 'too many connections from this address');
      return;
    }
    const id = match.at(1) ?? '';
    let box = this.boxes.get(id);
    if (role === 'phone' && !box?.laptop) {
      this.refuse(
        ws,
        CLOSE.noLaptop,
        'the laptop is not listening (is Triage running, with the companion on?)',
      );
      return;
    }
    if (box?.[role]) {
      this.refuse(
        ws,
        CLOSE.taken,
        role === 'phone' ? 'another phone is in this mailbox' : 'another laptop is in this mailbox',
      );
      return;
    }
    if (!box) {
      if (this.boxes.size >= this.limits.mailboxes) {
        this.refuse(ws, CLOSE.tooMany, 'the relay is full');
        return;
      }
      box = { lastMessage: Date.now() };
      this.boxes.set(id, box);
      this.stats.mailboxes = this.boxes.size;
    }
    box[role] = ws;
    box.lastMessage = Date.now();
    this.perAddress.set(address, count + 1);
    this.stats.connections++;
    const bucket = new Bucket(this.limits);
    const other = role === 'phone' ? 'laptop' : 'phone';
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const bytes = toBytes(data);
      if (!isBinary) {
        return; // only frames pass; text is ignored
      }
      if (!bucket.take(bytes.byteLength)) {
        this.refuse(ws, CLOSE.tooMany, 'too many messages');
        return;
      }
      const peer = box[other];
      if (!peer || peer.readyState !== peer.OPEN) {
        return; // a laptop's message with no phone in the mailbox is dropped
      }
      box.lastMessage = Date.now();
      this.stats.forwarded++;
      this.stats.bytes += bytes.byteLength;
      this.options.onForward?.(role, bytes);
      peer.send(bytes, { binary: true });
    });
    ws.on('error', () => {
      ws.terminate();
    });
    ws.on('close', () => {
      this.stats.connections--;
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left <= 0) {
        this.perAddress.delete(address);
      } else {
        this.perAddress.set(address, left);
      }
      if (box[role] === ws) {
        box[role] = undefined;
      }
      // One session per pair of connections: the other side starts over.
      const peer = box[other];
      if (peer) {
        box[other] = undefined;
        peer.close(CLOSE.peerLeft, `the ${role} left`);
      }
      if (!box.laptop && !box.phone && this.boxes.get(id) === box) {
        this.boxes.delete(id);
        this.stats.mailboxes = this.boxes.size;
      }
    });
    if (role === 'phone') {
      box.laptop?.send('phone joined');
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const box of this.boxes.values()) {
      if (box.phone && now - box.lastMessage > this.limits.idleMs) {
        box.phone.close(CLOSE.idle, 'idle');
        continue;
      }
      // A laptop waiting for a phone: ping, so NATs keep the connection.
      box.laptop?.ping();
    }
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
