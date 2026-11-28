/* global WebSocketPair */
// The phone companion's relay on Cloudflare Workers (ROADMAP PC-7; the owner chose
// Cloudflare, 2026-11-28): the same rules as the Node relay (../src/relay.ts), one
// Durable Object per mailbox. WebSocket hibernation keeps an idle laptop's
// connection open without paying for the time it waits.
//
// - `/v1/<32 hex digits>?role=laptop|phone`; one laptop and one phone per mailbox;
//   a phone needs its laptop to be there; when either leaves, the other is closed.
// - Only binary messages pass (sealed companion frames), at most 65,558 bytes each,
//   at most 400 a second per connection (twice that in a burst).
// - No keys, no accounts, no content logs: the frames are sealed end to end with
//   the Noise keys phone and laptop agreed through the QR code.
//
// Deploy: wrangler.toml beside this file (the Companion workflow's relay job, or
// `npx wrangler deploy` with the owner's Cloudflare account).

export const MAX_MESSAGE = 5 + 18 + 65_535;
export const MESSAGES_PER_SECOND = 400;
export const CLOSE = {
  peerLeft: 4000,
  noLaptop: 4004,
  taken: 4009,
  tooLarge: 1009,
  badRequest: 4400,
  tooMany: 4029,
};
const MAILBOX = /^\/v1\/([0-9a-f]{32})$/;

export default {
  /** @param {Request} request @param {{ MAILBOX: DurableObjectNamespace }} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
    }
    const match = MAILBOX.exec(url.pathname);
    if (!match || request.headers.get('Upgrade') !== 'websocket') {
      return new Response(
        'Triage companion relay: WebSocket only, /v1/<mailbox>?role=laptop|phone\n',
        { status: 400 },
      );
    }
    return env.MAILBOX.get(env.MAILBOX.idFromName(match[1])).fetch(request);
  },
};

/** One mailbox: a laptop, and at most one phone, forwarding sealed frames. */
export class Mailbox {
  /** @param {DurableObjectState} ctx */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** @param {Request} request */
  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (role !== 'laptop' && role !== 'phone') {
      server.accept();
      server.close(CLOSE.badRequest, 'expected role=laptop or role=phone');
      return new Response(null, { status: 101, webSocket: client });
    }
    const refuse = (code, reason) => {
      server.accept();
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (this.ctx.getWebSockets(role).length > 0) {
      return refuse(CLOSE.taken, `another ${role} is in this mailbox`);
    }
    if (role === 'phone' && this.ctx.getWebSockets('laptop').length === 0) {
      return refuse(
        CLOSE.noLaptop,
        'the laptop is not listening (is Triage running, with the companion on?)',
      );
    }
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, tokens: MESSAGES_PER_SECOND * 2, at: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** @param {WebSocket} ws @param {string | ArrayBuffer} message */
  async webSocketMessage(ws, message) {
    if (typeof message === 'string') {
      return; // only frames pass
    }
    const state = ws.deserializeAttachment();
    if (message.byteLength > MAX_MESSAGE) {
      ws.close(CLOSE.tooLarge, 'message too large');
      return;
    }
    const now = Date.now();
    state.tokens =
      Math.min(
        MESSAGES_PER_SECOND * 2,
        state.tokens + ((now - state.at) / 1000) * MESSAGES_PER_SECOND,
      ) - 1;
    state.at = now;
    ws.serializeAttachment(state);
    if (state.tokens < 0) {
      ws.close(CLOSE.tooMany, 'too many messages');
      return;
    }
    const peer = this.ctx.getWebSockets(state.role === 'phone' ? 'laptop' : 'phone')[0];
    peer?.send(message);
  }

  /** @param {WebSocket} ws */
  async webSocketClose(ws) {
    this.peerLeft(ws);
  }

  /** @param {WebSocket} ws */
  async webSocketError(ws) {
    this.peerLeft(ws);
  }

  /** One session per pair of connections: the other side starts over. */
  peerLeft(ws) {
    const role = ws.deserializeAttachment()?.role;
    const other = role === 'phone' ? 'laptop' : 'phone';
    for (const peer of this.ctx.getWebSockets(other)) {
      peer.close(CLOSE.peerLeft, `the ${role ?? 'peer'} left`);
    }
  }
}
