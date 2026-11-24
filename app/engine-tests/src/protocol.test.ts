import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  encodeStreamRequest,
  FrameDecoder,
  FrameError,
  FrameType,
  MAX_FRAME_BODY,
  parseHello,
  readU64,
} from '../../src/vs/triage/common/engineProtocol.js';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('engine frame codec', () => {
  it('writes the length of type + payload, little-endian, then the type', () => {
    expect([...encodeFrame(FrameType.Ping, bytes(9, 8, 7))]).toEqual([4, 0, 0, 0, 0x02, 9, 8, 7]);
    expect([...encodeStreamRequest(3, 0x01020304)]).toEqual([
      9, 0, 0, 0, 0x10, 3, 0, 0, 0, 4, 3, 2, 1,
    ]);
  });

  it('decodes frames split into single bytes and frames sharing a chunk', () => {
    const a = encodeFrame(FrameType.Data, new Uint8Array(1000).fill(7));
    const b = encodeFrame(FrameType.Pong, bytes(1, 2));
    const stream = new Uint8Array([...a, ...b]);

    const decoder = new FrameDecoder();
    const frames = [];
    for (const byte of stream) frames.push(...decoder.push(bytes(byte)));
    expect(frames.map((f) => [f.type, f.payload.byteLength])).toEqual([
      [FrameType.Data, 1000],
      [FrameType.Pong, 2],
    ]);
    expect(frames[0].payload.every((v) => v === 7)).toBe(true);

    expect(new FrameDecoder().push(stream).length).toBe(2);
  });

  it('rejects empty and oversized frames', () => {
    expect(() => new FrameDecoder().push(bytes(0, 0, 0, 0, 1))).toThrow(FrameError);
    const tooBig = new Uint8Array(5);
    new DataView(tooBig.buffer).setUint32(0, MAX_FRAME_BODY + 1, true);
    expect(() => new FrameDecoder().push(tooBig)).toThrow(/invalid frame length/);
  });

  it('reads the Hello and StreamEnd payloads', () => {
    expect(parseHello('triage-hello-engine 0.0.0 4242')).toEqual({
      name: 'triage-hello-engine',
      version: '0.0.0',
      pid: 4242,
    });
    expect(parseHello('nonsense')).toBeUndefined();
    const end = new Uint8Array(8);
    new DataView(end.buffer).setBigUint64(0, 5n * 2n ** 32n, true);
    expect(readU64(end)).toBe(5 * 2 ** 32);
  });
});
