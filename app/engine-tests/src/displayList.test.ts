import { describe, expect, it } from 'vitest';
import {
  DISPLAY_LIST_MAGIC,
  DisplayListError,
  DisplayListModel,
  PrimitiveKind,
  readChunkHeader,
} from '../../src/vs/triage/common/eda/displayList.js';

/** Builds a chunk as engines/eda/triage/stream_gal/display_list.cpp writes it. */
class ChunkWriter {
  private readonly words: number[] = [];
  private readonly view = new DataView(new ArrayBuffer(4));

  constructor(requestId: number, document: number, flags: number) {
    this.words.push(
      requestId >>> 0,
      Math.floor(requestId / 2 ** 32),
      DISPLAY_LIST_MAGIC,
      document,
      flags,
    );
  }

  u32(value: number): this {
    this.words.push(value >>> 0);
    return this;
  }

  f32(value: number): this {
    this.view.setFloat32(0, value, true);
    return this.u32(this.view.getUint32(0, true));
  }

  item(index: number, uuid: string): this {
    const bytes = new TextEncoder().encode(uuid);
    this.u32(3).u32(index).u32(bytes.length);
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    const view = new DataView(padded.buffer);
    for (let i = 0; i < padded.length; i += 4) this.u32(view.getUint32(i, true));
    return this;
  }

  group(
    id: number,
    layer: number,
    itemRef: number,
    runs: [PrimitiveKind, number, number[]][],
    lod = 0,
  ): this {
    this.u32(1).u32(id).u32(layer).u32(-3).u32(itemRef).f32(lod).u32(0).u32(0).u32(runs.length);
    for (const [kind, rgba, data] of runs) {
      this.u32(kind).u32(rgba).u32(data.length);
      for (const value of data) this.f32(value);
    }
    return this;
  }

  bytes(offset = 0): Uint8Array {
    const out = new Uint8Array(offset + this.words.length * 4);
    const view = new DataView(out.buffer, offset);
    this.words.forEach((word, i) => {
      view.setUint32(i * 4, word, true);
    });
    return out.subarray(offset);
  }
}

const UUID = '6b0a1c0e-2d3f-4a5b-8c7d-9e0f1a2b3c4d';

describe('Stream GAL display lists', () => {
  it('reads groups, item ids and primitive runs', () => {
    const chunk = new ChunkWriter(2 ** 33 + 5, 7, 3)
      .item(0, UUID)
      .group(10, 3, 1, [
        [PrimitiveKind.Segments, 0xff0000ff, [0, 0, 100, 0, 10]],
        [PrimitiveKind.Circles, 0x00ff00ff, [50, 50, 20, 0, 60, 60, 5, 2]],
      ])
      .group(11, 44, 0, [[PrimitiveKind.Triangles, 0x0000ffff, [0, 0, 1, 0, 0, 1]]], Infinity)
      .bytes();

    expect(readChunkHeader(chunk)).toEqual({
      requestId: 2 ** 33 + 5,
      document: 7,
      first: true,
      last: true,
    });
    const model = new DisplayListModel();
    const effect = model.apply(chunk);
    expect([...effect.layers].sort((a, b) => a - b)).toEqual([3, 44]);
    expect(model.groups.get(10)?.item).toBe(UUID);
    expect(model.groups.get(10)?.order).toBe(-3);
    expect(model.groups.get(11)?.item).toBeUndefined();
    expect(model.groups.get(11)?.lod).toBe(Infinity);
    expect([...(model.byItem.get(UUID) ?? [])]).toEqual([10]);
    expect(model.stats()).toEqual({ groups: 2, triangles: 1, segments: 1, circles: 2, arcs: 0 });
    expect([...(model.groups.get(10)?.runs[1].data ?? [])]).toEqual([50, 50, 20, 0, 60, 60, 5, 2]);
  });

  it('applies updates: a changed group replaces the old one, deletes remove', () => {
    const model = new DisplayListModel();
    model.apply(
      new ChunkWriter(1, 1, 3)
        .item(0, UUID)
        .group(1, 3, 1, [[PrimitiveKind.Segments, 1, [0, 0, 1, 1, 1]]])
        .group(2, 5, 1, [[PrimitiveKind.Segments, 1, [0, 0, 1, 1, 1]]])
        .bytes(),
    );
    // An update moves group 1 to layer 4 and deletes group 2 (op 2).
    const effect = model.apply(
      new ChunkWriter(2, 1, 2)
        .u32(2)
        .u32(2)
        .group(1, 4, 1, [[PrimitiveKind.Arcs, 9, [0, 0, 5, 0, 1, 1]]])
        .bytes(),
    );
    expect([...effect.layers].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(effect.deleted).toBe(1);
    expect(model.groups.size).toBe(1);
    expect(model.byLayer.get(3)?.size).toBe(0);
    expect(model.groups.get(1)?.layer).toBe(4);
    // The item index from the first chunk still resolves.
    expect(model.groups.get(1)?.item).toBe(UUID);
  });

  it('starts over on a first chunk and copies unaligned chunks', () => {
    const model = new DisplayListModel();
    model.apply(new ChunkWriter(1, 1, 3).group(1, 3, 0, []).bytes());
    const unaligned = new ChunkWriter(2, 1, 3)
      .group(9, 3, 0, [[PrimitiveKind.Segments, 1, [1, 2, 3, 4, 5]]])
      .bytes(1);
    expect(unaligned.byteOffset % 4).toBe(1);
    model.apply(unaligned);
    expect([...model.groups.keys()]).toEqual([9]);
    expect([...(model.groups.get(9)?.runs[0].data ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects chunks that are not display lists or are cut short', () => {
    const model = new DisplayListModel();
    expect(() => model.apply(new Uint8Array(24))).toThrow(DisplayListError);
    const good = new ChunkWriter(1, 1, 3)
      .group(1, 3, 0, [[PrimitiveKind.Segments, 1, [0, 0, 1, 1, 1]]])
      .bytes();
    expect(() => model.apply(good.slice(0, good.length - 8))).toThrow(DisplayListError);
  });
});
