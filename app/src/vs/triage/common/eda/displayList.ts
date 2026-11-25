/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Reads the Stream GAL's display lists (ROADMAP P1-3): the binary format in
 *  engines/eda/triage/stream_gal/display_list.h. A DisplayListModel keeps every
 *  group the engine sent for one document and applies updates (changed and
 *  deleted groups). No VS Code imports: tested in app/engine-tests.
 *--------------------------------------------------------------------------------------------*/

export const DISPLAY_LIST_MAGIC = 0x314C4454; // "TDL1"
export const DL_FIRST = 1;
export const DL_LAST = 2;

export const enum PrimitiveKind {
	Triangles = 1,
	/** Capsules: x1, y1, x2, y2, width. */
	Segments = 2,
	/** Discs (width 0) and rings: cx, cy, r, width. */
	Circles = 3,
	/** Stroked arcs with round ends: cx, cy, r, start angle, end angle, width. */
	Arcs = 4,
	/**
	 * One bitmap per run: x, y of pixel (0, 0)'s corner, the image's width and height
	 * as world vectors (ux, uy, vx, vy), its size in pixels (w, h), then w * h RGBA
	 * pixels as raw bytes (read them with {@link imagePixels}, not as floats).
	 */
	Images = 5,
}

/** Floats per primitive (per vertex for triangles). */
export const FLOATS_PER: Record<PrimitiveKind, number> = {
	[PrimitiveKind.Triangles]: 2,
	[PrimitiveKind.Segments]: 5,
	[PrimitiveKind.Circles]: 4,
	[PrimitiveKind.Arcs]: 6,
	[PrimitiveKind.Images]: 0,
};

/** The pixels of an {@link PrimitiveKind.Images} run, as RGBA bytes. */
export function imagePixels(run: PrimitiveRun): Uint8Array {
	const d = run.data;
	return new Uint8Array(d.buffer, d.byteOffset + 8 * 4, (d.length - 8) * 4);
}

export interface PrimitiveRun {
	readonly kind: PrimitiveKind;
	/** 0xRRGGBBAA */
	readonly rgba: number;
	readonly data: Float32Array;
}

export interface DisplayGroup {
	readonly id: number;
	readonly layer: number;
	readonly order: number;
	/** KIID of the item that drew the group, if any. */
	readonly item: string | undefined;
	/** Visible while lod < VIEW scale (Infinity: hidden). */
	readonly lod: number;
	/** ChangeGroupColor: every primitive drawn in this colour instead (0xRRGGBBAA). */
	readonly overrideRgba: number | undefined;
	readonly runs: readonly PrimitiveRun[];
}

export interface ChunkHeader {
	readonly requestId: number;
	readonly document: number;
	readonly first: boolean;
	readonly last: boolean;
}

export class DisplayListError extends Error { }

export function readChunkHeader(chunk: Uint8Array): ChunkHeader {
	if (chunk.byteLength < 20) {
		throw new DisplayListError('display-list chunk too short');
	}
	const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	if (view.getUint32(8, true) !== DISPLAY_LIST_MAGIC) {
		throw new DisplayListError('not a display-list chunk');
	}
	const flags = view.getUint32(16, true);
	return {
		requestId: view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32,
		document: view.getUint32(12, true),
		first: (flags & DL_FIRST) !== 0,
		last: (flags & DL_LAST) !== 0,
	};
}

/** What one chunk changed: the layers to rebuild on the GPU. */
export interface ChunkEffect {
	readonly header: ChunkHeader;
	readonly layers: ReadonlySet<number>;
	readonly groups: number;
	readonly deleted: number;
}

export class DisplayListModel {
	readonly groups = new Map<number, DisplayGroup>();
	/** Item index (from ITEM ops) to KIID. */
	private readonly items: string[] = [];
	/** Groups per layer, kept in step with `groups`. */
	readonly byLayer = new Map<number, Set<number>>();
	/** Groups per item KIID. */
	readonly byItem = new Map<string, Set<number>>();

	clear(): void {
		this.groups.clear();
		this.items.length = 0;
		this.byLayer.clear();
		this.byItem.clear();
	}

	apply(chunk: Uint8Array): ChunkEffect {
		// Float runs are viewed in place, so the chunk must start 4-byte aligned.
		if (chunk.byteOffset % 4 !== 0) {
			chunk = chunk.slice();
		}
		const header = readChunkHeader(chunk);
		const layers = new Set<number>();
		if (header.first) {
			for (const layer of this.byLayer.keys()) {
				layers.add(layer);
			}
			this.clear();
		}
		const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const end = chunk.byteLength;
		let offset = 20;
		let groups = 0;
		let deleted = 0;
		const u32 = () => {
			if (offset + 4 > end) {
				throw new DisplayListError('truncated display list');
			}
			const value = view.getUint32(offset, true);
			offset += 4;
			return value;
		};
		while (offset < end) {
			const op = u32();
			switch (op) {
				case 1: {
					const id = u32();
					const layer = view.getInt32(offset, true); offset += 4;
					const order = view.getInt32(offset, true); offset += 4;
					const itemRef = u32();
					const lod = view.getFloat32(offset, true); offset += 4;
					const flags = u32();
					const override = u32();
					const runCount = u32();
					const runs: PrimitiveRun[] = [];
					for (let i = 0; i < runCount; i++) {
						const kind = u32() as PrimitiveKind;
						const rgba = u32();
						const floats = u32();
						if (offset + floats * 4 > end) {
							throw new DisplayListError('truncated primitive run');
						}
						runs.push({ kind, rgba, data: new Float32Array(chunk.buffer, chunk.byteOffset + offset, floats) });
						offset += floats * 4;
					}
					const item = itemRef > 0 ? this.items[itemRef - 1] : undefined;
					this.remove(id, layers);
					const group: DisplayGroup = { id, layer, order, item, lod, overrideRgba: (flags & 1) ? override : undefined, runs };
					this.groups.set(id, group);
					this.index(this.byLayer, layer, id);
					if (item) {
						this.index(this.byItem, item, id);
					}
					layers.add(layer);
					groups++;
					break;
				}
				case 2: {
					if (this.remove(u32(), layers)) {
						deleted++;
					}
					break;
				}
				case 3: {
					const index = u32();
					const length = u32();
					if (offset + length > end) {
						throw new DisplayListError('truncated item id');
					}
					this.items[index] = new TextDecoder().decode(chunk.subarray(offset, offset + length));
					offset += Math.ceil(length / 4) * 4;
					break;
				}
				default:
					throw new DisplayListError(`unknown display-list op ${op}`);
			}
		}
		return { header, layers, groups, deleted };
	}

	private index<K>(map: Map<K, Set<number>>, key: K, id: number): void {
		let set = map.get(key);
		if (!set) {
			set = new Set();
			map.set(key, set);
		}
		set.add(id);
	}

	private remove(id: number, layers: Set<number>): boolean {
		const old = this.groups.get(id);
		if (!old) {
			return false;
		}
		this.groups.delete(id);
		this.byLayer.get(old.layer)?.delete(id);
		if (old.item) {
			this.byItem.get(old.item)?.delete(id);
		}
		layers.add(old.layer);
		return true;
	}

	/** Primitive counts, for tests and the status line. */
	stats(): { groups: number; triangles: number; segments: number; circles: number; arcs: number; images: number } {
		let triangles = 0, segments = 0, circles = 0, arcs = 0, images = 0;
		for (const group of this.groups.values()) {
			for (const run of group.runs) {
				if (run.kind === PrimitiveKind.Images) {
					images++;
					continue;
				}
				const n = run.data.length / FLOATS_PER[run.kind];
				switch (run.kind) {
					case PrimitiveKind.Triangles: triangles += n / 3; break;
					case PrimitiveKind.Segments: segments += n; break;
					case PrimitiveKind.Circles: circles += n; break;
					case PrimitiveKind.Arcs: arcs += n; break;
				}
			}
		}
		return { groups: this.groups.size, triangles, segments, circles, arcs, images };
	}
}
