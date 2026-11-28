// The companion protocol's parsers and rules (ROADMAP PC-2: fuzz tests of the
// protocol parser; a view-only phone's edits refused).
import { describe, expect, it } from 'vitest';
import {
  decodeEnvelope,
  edaPermission,
  encodeEnvelope,
  permits,
  PHONE_REQUESTS,
} from '../../../app/src/vs/triage/common/companion/protocol.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  decodePairingLink,
  decodeQrPayload,
  normalizeCode,
} from '../../../app/src/vs/triage/common/companion/qr.js';
import { parseRefusal, parseWholeFrame } from '../../../app/src/vs/triage/common/companion/wire.js';
import * as api from '../../../app/src/vs/triage/common/eda/engineApi.generated.js';
import { decodeMessage, encodeMessage } from '../../../app/src/vs/triage/common/eda/protobuf.js';
import { addon } from './addon.js';

/** A deterministic random source (xorshift), so a failing case can be replayed. */
function random(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

function bytes(next: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

describe('envelopes', () => {
  it('round-trip, with binary blobs', () => {
    const blob = Uint8Array.from([0, 1, 2, 255]);
    const envelope = decodeEnvelope(
      encodeEnvelope({
        id: 7,
        kind: 'eda',
        json: '{"a":1}',
        blobs: [blob, new Uint8Array(70_000)],
      }),
    );
    expect(envelope.id).toBe(7);
    expect(envelope.kind).toBe('eda');
    expect(envelope.json).toBe('{"a":1}');
    expect([...(envelope.blobs[0] ?? [])]).toEqual([0, 1, 2, 255]);
    expect(envelope.blobs[1]?.byteLength).toBe(70_000);
  });

  it('refuse bytes that are not an envelope, and never hang or crash (fuzz)', () => {
    const next = random(0x5eed);
    let refused = 0;
    for (let i = 0; i < 5000; i++) {
      const input = bytes(next, Math.floor(next() * 120));
      try {
        const envelope = decodeEnvelope(input);
        expect(envelope.kind.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(4000);
  });

  it('keep the EDA request parser safe on random bytes (fuzz)', () => {
    const next = random(42);
    for (let i = 0; i < 3000; i++) {
      try {
        const request = decodeMessage(api.Request, bytes(next, Math.floor(next() * 80)));
        // Whatever decodes, the permission rule gives an answer.
        expect([undefined, 'view', 'edit']).toContain(edaPermission(request));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});

describe('what a phone may ask', () => {
  const request = (body: Record<string, unknown>) =>
    decodeMessage(api.Request, encodeMessage(api.Request, { id: 1, ...body }));

  it('views with view permission, edits only with edit permission', () => {
    expect(edaPermission(request({ getDisplayList: { document: 1 } }))).toBe('view');
    expect(edaPermission(request({ hitTest: { document: 1, x: 1, y: 2 } }))).toBe('view');
    expect(edaPermission(request({ getItems: { document: 1, references: ['R1'] } }))).toBe('view');
    for (const edit of [
      { move: { uuids: ['a'], dx: 1 } },
      { rotate: { uuids: ['a'], degrees: 90 } },
      { delete: { uuids: ['a'] } },
      { setField: { uuid: 'a', field: 'Value', text: '1k' } },
    ]) {
      expect(edaPermission(request({ edit: { document: 1, ...edit } }))).toBe('edit');
    }
    expect(edaPermission(request({ undo: { document: 1 } }))).toBe('edit');
    expect(edaPermission(request({ save: { document: 1 } }))).toBe('edit');
    expect(permits('view', 'edit')).toBe(false);
    expect(permits('edit', 'edit')).toBe(true);
    expect(permits('view', 'view')).toBe(true);
  });

  it('never: files by path, reloads, routing, placing parts, wires, tracks, renaming nets', () => {
    expect(edaPermission(request({ openDocument: { path: '/etc/passwd' } }))).toBeUndefined();
    expect(edaPermission(request({ closeDocument: { document: 1 } }))).toBeUndefined();
    expect(edaPermission(request({ reload: { document: 1 } }))).toBeUndefined();
    expect(edaPermission(request({ route: { document: 1 } }))).toBeUndefined();
    expect(edaPermission(request({ highlight: { document: 1, net: 'GND' } }))).toBeUndefined();
    for (const edit of [
      { renameNet: { from: 'A', to: 'B' } },
      { addWire: {} },
      { addTrack: {} },
      { placeFootprint: { libId: 'x:y' } },
      { placeSymbol: {} },
    ]) {
      expect(edaPermission(request({ edit: { document: 1, ...edit } }))).toBeUndefined();
    }
    // Two commands in one request.
    expect(edaPermission({ id: 1, getDisplayList: {}, save: {} })).toBeUndefined();
  });

  it('sim controls and 3D edits need edit permission; looking needs view', () => {
    expect(PHONE_REQUESTS['sim.run']).toBe('edit');
    expect(PHONE_REQUESTS['sim.input']).toBe('edit');
    expect(PHONE_REQUESTS['cad.setProperty']).toBe('edit');
    expect(PHONE_REQUESTS['sim.state']).toBe('view');
    expect(PHONE_REQUESTS['cad.scene']).toBe('view');
    expect(PHONE_REQUESTS['terminal']).toBeUndefined();
  });
});

describe('QR payloads and frames', () => {
  it('parse what the laptop writes', () => {
    if (!addon) {
      return;
    }
    const payload = {
      id: addon.randomBytes(16),
      secret: addon.randomBytes(32),
      laptopKey: addon.randomBytes(32),
      certificateHash: addon.randomBytes(32),
      expires: 1_900_000_000,
      view: '3d' as const,
      addresses: ['192.168.1.20:47120', '[fd00::1]:47120'],
      relay: 'wss://relay.example',
    };
    const link = addon.qrLink(payload, 'https://example.github.io/triage');
    const read = decodePairingLink(link);
    expect(base64UrlEncode(read.id)).toBe(base64UrlEncode(payload.id));
    expect(base64UrlEncode(read.secret)).toBe(base64UrlEncode(payload.secret));
    expect(read.view).toBe('3d');
    expect(read.addresses).toEqual(['192.168.1.20:47120', '[fd00:0:0:0:0:0:0:1]:47120']);
    expect(read.relay).toBe('wss://relay.example');
    expect(read.expires).toBe(1_900_000_000);
    for (const code of ['abcd-efgh', 'o1il 2345', 'ABCDEFGU', 'short']) {
      expect(normalizeCode(code) ?? null).toBe(addon.normalizeCode(code));
    }
  });

  it('refuse damaged payloads and frames (fuzz)', () => {
    const next = random(7);
    for (let i = 0; i < 3000; i++) {
      const input = bytes(next, Math.floor(next() * 200));
      expect(() => decodeQrPayload(input)).toThrow();
      try {
        parseWholeFrame(input);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
    expect(() => base64UrlDecode('not base64!')).toThrow();
    expect(parseRefusal(Uint8Array.from([6, 0x68, 0x69]))).toEqual({
      reason: 'denied',
      text: 'hi',
    });
  });
});
