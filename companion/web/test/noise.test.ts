// The phone's Noise code (WebCrypto) against the laptop's (snow, in the addon):
// every handshake byte for byte, and transport both ways with fragments.
import { describe, expect, it } from 'vitest';
import {
  codeMailbox,
  codePsk,
  generateKeyPair,
  NoiseInitiator,
} from '../../../app/src/vs/triage/common/companion/noise.js';
import { normalizeCode } from '../../../app/src/vs/triage/common/companion/qr.js';
import { addon } from './addon.js';

describe.skipIf(!addon)('Noise: WebCrypto (phone) and snow (laptop) agree', () => {
  // describe.skipIf has already skipped when the addon is missing.
  const a = addon ?? ({} as NonNullable<typeof addon>);

  async function run(
    mode: 'pair' | 'reconnect' | 'code',
    pskPhone?: Uint8Array,
    pskLaptop?: Uint8Array,
  ) {
    const laptop = a.generateKeypair();
    const phone = await generateKeyPair();
    const id = a.randomBytes(16);
    const initiator = new NoiseInitiator(
      mode === 'code'
        ? { mode, id, psk: pskPhone }
        : {
            mode,
            id,
            staticKey: phone,
            laptopKey: laptop.public,
            ...(pskPhone ? { psk: pskPhone } : {}),
          },
    );
    const responder = new a.TestResponder(mode, id, laptop.private, pskLaptop ?? null);
    responder.readInit(await initiator.writeInit());
    if (mode !== 'code') {
      expect(Buffer.from(responder.remoteStatic() ?? []).toString('hex')).toBe(
        Buffer.from(phone.publicKey).toString('hex'),
      );
    }
    const { channel } = await initiator.readReply(responder.writeReply(new Uint8Array(0)));
    return { channel, responder };
  }

  it('pairs (IKpsk2): the same six digits, messages both ways, a 300 KB message in fragments', async () => {
    const psk = a.randomBytes(32);
    const { channel, responder } = await run('pair', psk, psk);
    expect(channel.sas).toBe(responder.sas());
    const big = new Uint8Array(300_000).map((_, i) => i & 255);
    let received: Uint8Array | null = null;
    for (const sealed of await channel.seal(big)) {
      received = responder.open(sealed);
    }
    expect(received?.byteLength).toBe(300_000);
    expect(received?.[1234]).toBe(1234 & 255);
    let back: Uint8Array | undefined;
    for (const sealed of responder.seal(new TextEncoder().encode('from the laptop'))) {
      back = await channel.open(sealed);
    }
    expect(new TextDecoder().decode(back)).toBe('from the laptop');
  });

  it('fails a wrong secret on the phone (psk2)', async () => {
    await expect(run('pair', a.randomBytes(32), a.randomBytes(32))).rejects.toThrow();
  });

  it('reconnects (IK) and pairs with a typed code (NNpsk0)', async () => {
    const reconnect = await run('reconnect');
    expect(reconnect.channel.sas).toBe(reconnect.responder.sas());
    const code = normalizeCode(a.newCode()) ?? '';
    expect(Buffer.from(await codeMailbox(code)).toString('hex')).toBe(
      Buffer.from(a.codeMailbox(code)).toString('hex'),
    );
    const psk = await codePsk(code);
    const typed = await run('code', psk, a.codePsk(code));
    expect(typed.channel.sas).toBe(typed.responder.sas());
  });
});
