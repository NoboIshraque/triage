import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from '../../src/vs/triage/common/eda/engineApi.generated.js';
import {
  decodeMessage,
  encodeMessage,
  peekId,
  ProtobufError,
} from '../../src/vs/triage/common/eda/protobuf.js';
import type { Message, MessageDescriptor } from '../../src/vs/triage/common/eda/protobuf.js';
// @ts-expect-error: a plain .mjs script without type declarations
import { generate as generateUntyped } from '../../../scripts/eda/proto-to-ts.mjs';

const generate = generateUntyped as (proto: string) => string;

/** Decodes into a typed shape (the codec's messages are untyped records). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function decode<T>(descriptor: MessageDescriptor, bytes: Uint8Array): T {
  return decodeMessage(descriptor, bytes) as unknown as T;
}

interface Layer {
  color: number;
  order: number;
  visible: boolean;
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

describe('triage.eda.v1 descriptors', () => {
  it('are generated from engine.proto and up to date', () => {
    const proto = readFileSync(
      path.join(repoRoot, 'engines/eda/triage/api/proto/triage/eda/v1/engine.proto'),
      'utf8',
    );
    const current = readFileSync(
      path.join(repoRoot, 'app/src/vs/triage/common/eda/engineApi.generated.ts'),
      'utf8',
    );
    expect(generate(proto)).toBe(current);
  });
});

describe('protobuf codec', () => {
  it('round-trips a request with a nested oneof member', () => {
    const bytes = encodeMessage(api.Request, {
      id: 42,
      openDocument: { path: '/tmp/a.kicad_pcb' },
    });
    // Field 1 varint 42, field 11 length-delimited { field 1: string }.
    expect([...bytes.subarray(0, 2)]).toEqual([0x08, 42]);
    const back = decode<{ id: number; openDocument: { path: string }; getVersion?: Message }>(
      api.Request,
      bytes,
    );
    expect(back.id).toBe(42);
    expect(back.openDocument.path).toBe('/tmp/a.kicad_pcb');
    expect(back.getVersion).toBeUndefined();
    expect(peekId(bytes)).toBe(42);
  });

  it('writes empty oneof members, which mark the command', () => {
    const bytes = encodeMessage(api.Request, { id: 1, getVersion: {} });
    const back = decode<{ getVersion?: Message }>(api.Request, bytes);
    expect(back.getVersion).toEqual({});
  });

  it('packs repeated numbers and keeps doubles, negative ints and enums', () => {
    const points = [0, 1.5, -2.25, 1e9, 123456789.125];
    const edit = encodeMessage(api.Edit, {
      document: 3,
      addTrack: { points, width: 250000, layer: -1, net: 'GND' },
    });
    const back = decode<{
      document: number;
      addTrack: { points: number[]; layer: number; net: string };
    }>(api.Edit, edit);
    expect(back.document).toBe(3);
    expect(back.addTrack.points).toEqual(points);
    expect(back.addTrack.layer).toBe(-1);
    expect(back.addTrack.net).toBe('GND');

    const info = decode<{
      kind: number;
      layers: Layer[];
      bbox: Message;
      path: string;
      modified: boolean;
    }>(
      api.DocumentInfo,
      encodeMessage(api.DocumentInfo, {
        document: 1,
        kind: api.DocumentKind.DOCUMENT_KIND_SCHEMATIC,
        layers: [
          { id: 3, name: 'F.Cu', color: 0xc83434ff, order: -5, visible: true },
          { id: 40, name: 'Edge.Cuts', color: 0xd0d2cdff, order: 12, visible: false },
        ],
        bbox: { x0: -1, y0: 0, x1: 2.5, y1: 1e8 },
      }),
    );
    expect(info.kind).toBe(2);
    expect(info.layers).toHaveLength(2);
    expect(info.layers[0].color).toBe(0xc83434ff);
    expect(info.layers[0].order).toBe(-5);
    expect(info.layers[1].visible).toBe(false);
    expect(info.bbox).toEqual({ x0: -1, y0: 0, x1: 2.5, y1: 1e8 });
    // Absent scalars decode as proto3 defaults.
    expect(info.path).toBe('');
    expect(info.modified).toBe(false);
  });

  it('skips unknown fields and rejects truncated input', () => {
    const bytes = encodeMessage(api.Response, {
      id: 7,
      ok: true,
      version: { engine: 'triage-eda-engine 0.1.0', faces: ['pcb', 'sch'] },
    });
    // Decoding a Response as a Version-less descriptor still works.
    const partial = decode<{ id: number }>(
      { name: 'Partial', fields: [api.Response.fields[0]] },
      bytes,
    );
    expect(partial.id).toBe(7);
    expect(() => decodeMessage(api.Response, bytes.subarray(0, bytes.length - 3))).toThrow(
      ProtobufError,
    );
  });
});
