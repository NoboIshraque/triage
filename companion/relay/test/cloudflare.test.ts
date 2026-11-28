// The Cloudflare relay's mailbox (cloudflare/relay-worker.js) with in-memory
// stand-ins for the Workers runtime: the same rules as the Node relay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as worker from '../cloudflare/relay-worker.js';

interface Socket {
  role?: string;
  attachment: unknown;
  sent: unknown[];
  closed?: { code: number; reason: string };
  peer?: Socket;
  accept(): void;
  send(message: unknown): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

function socket(): Socket {
  return {
    attachment: undefined,
    sent: [],
    accept() {
      // the stand-in needs no handshake
    },
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    serializeAttachment(value) {
      this.attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

interface MailboxInstance {
  fetch(request: Request): Promise<{ status: number; webSocket: Socket }>;
  webSocketMessage(ws: Socket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: Socket): Promise<void>;
}
type MailboxClass = new (ctx: unknown) => MailboxInstance;
const { Mailbox, CLOSE, MAX_MESSAGE } = worker as unknown as {
  Mailbox: MailboxClass;
  CLOSE: Record<string, number>;
  MAX_MESSAGE: number;
};

describe('the Cloudflare relay (one Durable Object per mailbox)', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { WebSocketPair: globals['WebSocketPair'], Response: globals['Response'] };
  let servers: Socket[] = [];
  beforeAll(() => {
    globals['WebSocketPair'] = function WebSocketPair() {
      const client = socket();
      const server = socket();
      client.peer = server;
      servers.push(server);
      return { 0: client, 1: server };
    };
    // Workers allow status 101 with a webSocket; Node's Response doesn't.
    globals['Response'] = class {
      status: number;
      webSocket: unknown;
      constructor(_body: unknown, init: { status: number; webSocket?: unknown }) {
        this.status = init.status;
        this.webSocket = init.webSocket;
      }
    };
  });
  afterAll(() => {
    globals['WebSocketPair'] = saved.WebSocketPair;
    globals['Response'] = saved.Response;
  });

  function mailbox() {
    const accepted: Socket[] = [];
    const ctx = {
      acceptWebSocket(ws: Socket, tags: string[]) {
        ws.role = tags[0] ?? '';
        accepted.push(ws);
      },
      getWebSockets(tag: string) {
        return accepted.filter((ws) => ws.role === tag && !ws.closed);
      },
    };
    return { box: new Mailbox(ctx), accepted };
  }
  const join = async (box: MailboxInstance, role: string) => {
    servers = [];
    await box.fetch(new Request(`https://relay/v1/${'a'.repeat(32)}?role=${role}`));
    const server = servers.at(0);
    if (!server) throw new Error('no socket');
    return server;
  };

  it('forwards frames between the laptop and the phone, and nothing else', async () => {
    const { box } = mailbox();
    const lonely = await join(box, 'phone');
    expect(lonely.closed?.code).toBe(CLOSE['noLaptop']);
    const laptop = await join(box, 'laptop');
    expect((await join(box, 'laptop')).closed?.code).toBe(CLOSE['taken']);
    const phone = await join(box, 'phone');
    expect(phone.closed).toBeUndefined();
    const frame = new Uint8Array([5, 0, 0, 0, 0x20, 1]).buffer;
    await box.webSocketMessage(phone, frame);
    expect(laptop.sent).toEqual([frame]);
    await box.webSocketMessage(phone, 'text is not a frame');
    expect(laptop.sent).toHaveLength(1);
    // The phone leaves: the laptop is closed and opens its mailbox again.
    phone.closed = { code: 1000, reason: '' };
    await box.webSocketClose(phone);
    expect(laptop.closed?.code).toBe(CLOSE['peerLeft']);
  });

  it('closes a connection that sends too large or too fast', async () => {
    const { box } = mailbox();
    await join(box, 'laptop');
    const phone = await join(box, 'phone');
    await box.webSocketMessage(phone, new ArrayBuffer(MAX_MESSAGE + 1));
    expect(phone.closed?.code).toBe(CLOSE['tooLarge']);
    const { box: second } = mailbox();
    await join(second, 'laptop');
    const fast = await join(second, 'phone');
    for (let i = 0; i < 1000 && !fast.closed; i++) {
      await second.webSocketMessage(fast, new ArrayBuffer(8));
    }
    expect(fast.closed?.code).toBe(CLOSE['tooMany']);
  });
});
