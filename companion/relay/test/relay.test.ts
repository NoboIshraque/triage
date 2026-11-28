// The relay alone (limits, mailboxes), then the whole path a phone on mobile data
// takes (ROADMAP PC-7): the phone's TypeScript (WebCrypto Noise, the session, the
// relay link) → this relay → the laptop's Rust server (triage_companion.node),
// with a check that the relay saw only ciphertext.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayLink } from '../../../app/src/vs/triage/browser/companion/links.js';
import type {
  ICompanionAddon,
  ICompanionServer,
  CompanionAddonEvent,
} from '../../../app/src/vs/triage/common/companion/addon.js';
import {
  codeMailbox,
  codePsk,
  generateKeyPair,
} from '../../../app/src/vs/triage/common/companion/noise.js';
import {
  decodeEnvelope,
  encodeEnvelope,
} from '../../../app/src/vs/triage/common/companion/protocol.js';
import {
  CompanionClosed,
  CompanionSession,
} from '../../../app/src/vs/triage/common/companion/session.js';
import { CLOSE, Relay } from '../src/relay.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const addonPath = path.join(repoRoot, 'build', 'native', 'addons', 'triage_companion.node');
const required = process.env['TRIAGE_REQUIRE_ADDON'] === '1';
const haveAddon = existsSync(addonPath);
if (required && !haveAddon) {
  throw new Error(
    `TRIAGE_REQUIRE_ADDON=1 but ${addonPath} is missing: node crates/triage-companion-node/build.mjs`,
  );
}

function socket(
  url: string,
): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.addEventListener('close', (e) => {
        done({ code: e.code, reason: e.reason });
      });
    });
    ws.addEventListener(
      'open',
      () => {
        resolve({ ws, closed });
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        resolve({ ws, closed });
      },
      { once: true },
    );
    setTimeout(() => {
      reject(new Error('timeout'));
    }, 5000);
  });
}

const hex = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString('hex');

/** The value, or a test failure if it's missing. */
function must<T>(value: T | null | undefined, what = 'a value'): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

describe('relay', () => {
  let relay: Relay;
  let url: string;
  beforeAll(async () => {
    relay = new Relay({ limits: { messagesPerSecond: 50, maxMessage: 70_000 } });
    url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;
  });
  afterAll(() => relay.close());

  it('refuses bad paths, phones without a laptop, and a second peer', async () => {
    const bad = await socket(`${url}/v1/xyz?role=phone`);
    expect((await bad.closed).code).toBe(CLOSE.badRequest);
    const mailbox = '00112233445566778899aabbccddeeff';
    const lonely = await socket(`${url}/v1/${mailbox}?role=phone`);
    expect((await lonely.closed).code).toBe(CLOSE.noLaptop);
    const laptop = await socket(`${url}/v1/${mailbox}?role=laptop`);
    const second = await socket(`${url}/v1/${mailbox}?role=laptop`);
    expect((await second.closed).code).toBe(CLOSE.taken);
    const phone = await socket(`${url}/v1/${mailbox}?role=phone`);
    const got = new Promise<Uint8Array>((resolve) => {
      laptop.ws.addEventListener('message', (e) => {
        if (e.data instanceof ArrayBuffer) {
          resolve(new Uint8Array(e.data));
        }
      });
    });
    phone.ws.send(Uint8Array.of(1, 2, 3));
    expect([...(await got)]).toEqual([1, 2, 3]);
    // When the phone leaves, the laptop is closed too and opens its mailbox again.
    phone.ws.close();
    expect((await laptop.closed).code).toBe(CLOSE.peerLeft);
  });

  it('closes a connection that sends too fast or too large', async () => {
    const mailbox = 'ffeeddccbbaa99887766554433221100';
    const laptop = await socket(`${url}/v1/${mailbox}?role=laptop`);
    const phone = await socket(`${url}/v1/${mailbox}?role=phone`);
    for (let i = 0; i < 200; i++) {
      phone.ws.send(Uint8Array.of(i & 255));
    }
    expect((await phone.closed).code).toBe(CLOSE.tooMany);
    await laptop.closed;
    const laptop2 = await socket(`${url}/v1/${mailbox}?role=laptop`);
    const phone2 = await socket(`${url}/v1/${mailbox}?role=phone`);
    phone2.ws.send(new Uint8Array(80_000));
    // 1009 (message too big); Windows' sockets may drop the close frame: 1006.
    expect([1009, 1006]).toContain((await phone2.closed).code);
    await laptop2.closed;
  });
});

describe.skipIf(!haveAddon)(
  'a phone through the relay to the laptop (triage_companion.node)',
  () => {
    const addon = (
      haveAddon ? createRequire(import.meta.url)(addonPath) : undefined
    ) as ICompanionAddon;
    let relay: Relay;
    let url: string;
    let server: ICompanionServer;
    let laptopKeys: { private: Uint8Array; public: Uint8Array };
    const seen: Uint8Array[] = [];
    const events: CompanionAddonEvent[] = [];
    const waiters: ((event: CompanionAddonEvent) => boolean)[] = [];

    async function next(
      kind: CompanionAddonEvent['kind'],
      timeoutMs = 15_000,
    ): Promise<CompanionAddonEvent> {
      const index = events.findIndex((e) => e.kind === kind);
      if (index >= 0) {
        return events.splice(index, 1)[0];
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no ${kind} event`));
        }, timeoutMs);
        waiters.push((event) => {
          if (event.kind !== kind) {
            return false;
          }
          clearTimeout(timer);
          resolve(event);
          return true;
        });
      });
    }

    async function mailboxOpen(mailbox: Uint8Array): Promise<void> {
      for (;;) {
        const event = await next('relay');
        if (event.connected && hex(event.id) === hex(mailbox)) {
          return;
        }
      }
    }

    beforeAll(async () => {
      relay = new Relay({ onForward: (_, bytes) => seen.push(bytes.slice()) });
      url = `ws://127.0.0.1:${await relay.listen(0, '127.0.0.1')}`;
      laptopKeys = addon.generateKeypair();
      server = new addon.CompanionServer(laptopKeys.private);
      void (async () => {
        for (;;) {
          const event = await server.nextEvent();
          if (!event) {
            return;
          }
          const waiter = waiters.findIndex((w) => w(event));
          if (waiter >= 0) {
            waiters.splice(waiter, 1);
          } else {
            events.push(event);
          }
        }
      })();
    });
    afterAll(async () => {
      await server.shutdown();
      await relay.close();
    });

    it("pairs with a QR code's secret, agrees on the six digits and carries requests and events", async () => {
      const id = addon.randomBytes(16);
      const secret = addon.randomBytes(32);
      server.addPairing(id, 'pair', secret, Date.now() + 90_000);
      await server.setRelay(url, [id]);
      await mailboxOpen(id);
      const phoneKey = await generateKeyPair();
      const link = await RelayLink.open(url, id);
      const session = await CompanionSession.start(link, {
        mode: 'pair',
        id,
        staticKey: phoneKey,
        laptopKey: laptopKeys.public,
        psk: secret,
        hello: { app: 'test', version: '0', name: 'Test phone' },
      });
      const handshake = await next('handshake');
      expect(handshake.sas).toBe(session.sas);
      expect(handshake.route).toBe('relay');
      expect(hex(must(handshake.phoneKey))).toBe(hex(phoneKey.publicKey));
      expect((JSON.parse(decodeEnvelope(must(handshake.data)).json) as { name: string }).name).toBe(
        'Test phone',
      );
      // The laptop allows it: welcome, then a request and its reply.
      server.consumePairing(id);
      const welcomed = new Promise((resolve) => {
        session.onEvent((e) => {
          if (e.kind === 'event:welcome') {
            resolve(JSON.parse(e.json));
          }
        });
      });
      expect(
        server.send(
          must(handshake.session),
          encodeEnvelope({ kind: 'event:welcome', json: JSON.stringify({ permission: 'view' }) }),
        ),
      ).toBe(true);
      expect(await welcomed).toEqual({ permission: 'view' });
      const reply = session.request('views', { secret: 'R1 = 4.7k' });
      const message = await next('message');
      const request = decodeEnvelope(must(message.data));
      expect(request.kind).toBe('views');
      const big = new Uint8Array(500_000).fill(7);
      server.send(
        must(handshake.session),
        encodeEnvelope({
          replyTo: request.id,
          kind: 'views',
          json: '{"board":true}',
          blobs: [big],
        }),
      );
      const answer = await reply;
      expect(answer.json).toBe('{"board":true}');
      expect(answer.blobs[0].byteLength).toBe(500_000);
      // The relay saw companion frames only, and none of the plaintext.
      expect(seen.length).toBeGreaterThan(5);
      for (const bytes of seen) {
        expect([0x20, 0x21, 0x22]).toContain(bytes[4]);
        const text = Buffer.from(bytes).toString('latin1');
        for (const plain of ['R1 = 4.7k', 'Test phone', 'board', 'welcome']) {
          expect(text.includes(plain)).toBe(false);
        }
      }
      session.close();
      expect((await next('closed')).session).toBe(handshake.session);
      // A reused QR code is refused.
      await mailboxOpen(id);
      const again = await RelayLink.open(url, id);
      await expect(
        CompanionSession.start(again, {
          mode: 'pair',
          id,
          staticKey: await generateKeyPair(),
          laptopKey: laptopKeys.public,
          psk: secret,
          hello: { app: 'test', version: '0', name: 'Second phone' },
        }),
      ).rejects.toMatchObject({ reason: 'expired' });
    });

    it('refuses a wrong secret and counts it', async () => {
      const id = addon.randomBytes(16);
      server.addPairing(id, 'pair', addon.randomBytes(32), Date.now() + 90_000);
      await server.setRelay(url, [id]);
      await mailboxOpen(id);
      const link = await RelayLink.open(url, id);
      // psk2: the phone notices first, as the laptop's reply doesn't decrypt.
      await expect(
        CompanionSession.start(link, {
          mode: 'pair',
          id,
          staticKey: await generateKeyPair(),
          laptopKey: laptopKeys.public,
          psk: addon.randomBytes(32),
          hello: { app: 'test', version: '0', name: 'Wrong' },
        }),
      ).rejects.toBeInstanceOf(CompanionClosed);
    });

    it('pairs with a typed code: the phone and the laptop derive the same mailbox and key', async () => {
      const code = addon.newCode();
      expect(hex(await codeMailbox(code))).toBe(hex(addon.codeMailbox(code)));
      const psk = await codePsk(code);
      expect(hex(psk)).toBe(hex(addon.codePsk(code)));
      const mailbox = addon.codeMailbox(code);
      server.addPairing(mailbox, 'code', psk, Date.now() + 90_000);
      await server.setRelay(url, [mailbox]);
      await mailboxOpen(mailbox);
      const link = await RelayLink.open(url, mailbox);
      const session = await CompanionSession.start(link, {
        mode: 'code',
        id: mailbox,
        psk,
        hello: { app: 'test', version: '0', name: 'Typed' },
      });
      const handshake = await next('handshake');
      expect(handshake.mode).toBe('code');
      expect(handshake.sas).toBe(session.sas);
      session.close();
      await next('closed');
    });

    it('reconnects a paired phone with its pinned keys and refuses a removed one', async () => {
      const phoneKey = await generateKeyPair();
      const mailbox = addon.randomBytes(16);
      server.setPhones([{ mailbox, key: phoneKey.publicKey }]);
      await server.setRelay(url, [mailbox]);
      await mailboxOpen(mailbox);
      const session = await CompanionSession.start(await RelayLink.open(url, mailbox), {
        mode: 'reconnect',
        id: mailbox,
        staticKey: phoneKey,
        laptopKey: laptopKeys.public,
        hello: { app: 'test', version: '0', name: 'Back' },
      });
      const handshake = await next('handshake');
      expect(handshake.mode).toBe('reconnect');
      session.close();
      await next('closed');
      server.setPhones([]);
      await mailboxOpen(mailbox);
      await expect(
        CompanionSession.start(await RelayLink.open(url, mailbox), {
          mode: 'reconnect',
          id: mailbox,
          staticKey: phoneKey,
          laptopKey: laptopKeys.public,
          hello: { app: 'test', version: '0', name: 'Removed' },
        }),
      ).rejects.toMatchObject({ reason: 'not-paired' });
    });
  },
);
