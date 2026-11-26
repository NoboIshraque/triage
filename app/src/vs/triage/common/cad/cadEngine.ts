/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The CAD engine's protocol (ROADMAP P2-2): FreeCAD's App layer behind JSON-RPC,
 *  over the P0-4 engine connection. The engine side is
 *  engines/cad/triage/engine/triage_cad/host.py; the mesh layout is described in
 *  tessellation.py there. No VS Code imports: tested in app/engine-tests.
 *--------------------------------------------------------------------------------------------*/

/** Frame types of the CAD engine, after the P0-4 ones (Hello, Ping, Error …). */
export const CadFrame = {
	/** broker -> engine: a JSON-RPC 2.0 request (UTF-8). */
	Request: 0x30,
	/** engine -> broker: the JSON-RPC 2.0 response (UTF-8), after its meshes. */
	Response: 0x31,
	/** engine -> broker: one object's mesh for a request (MESH_MAGIC). */
	Mesh: 0x32,
} as const;

/** "TCM1": Triage CAD mesh, version 1. */
export const MESH_MAGIC = 0x314d4354;
const MESH_HEADER = 32;

export interface CadRequest {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

export interface CadError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface CadResponse<T = unknown> {
	readonly jsonrpc: '2.0';
	readonly id: number | null;
	readonly result?: T;
	readonly error?: CadError;
}

/** An object in a document's feature tree (document.tree, document.open). */
export interface CadTreeItem {
	readonly name: string;
	readonly label: string;
	readonly type: string;
	readonly parent: string | null;
	readonly children: readonly string[];
	/** FreeCAD's state: Touched, Invalid, Error, Up-to-date … */
	readonly state: readonly string[];
	readonly visible: boolean;
	/** Whether the 3D view draws it (document.tessellate's default set). */
	readonly shown: boolean;
	readonly tip: string | null;
	/** A Python feature's class (Triage's "Enclosure" …), else null. */
	readonly proxy: string | null;
}

export interface CadDocument {
	readonly name: string;
	readonly label: string;
	readonly path: string | null;
	readonly objects: readonly CadTreeItem[];
	readonly canUndo: boolean;
	readonly canRedo: boolean;
}

export interface CadRecompute {
	readonly recomputed: number;
	readonly errors: readonly { readonly object: string; readonly label: string; readonly message: string }[];
	readonly milliseconds?: number;
}

/** What document.tessellate says about one mesh; the geometry comes in a Mesh frame. */
export interface CadMeshInfo {
	readonly object: string;
	readonly label: string;
	readonly type: string;
	/** xmin, ymin, zmin, xmax, ymax, zmax in mm. */
	readonly box: readonly [number, number, number, number, number, number];
	readonly faces: number;
	readonly edges: number;
	readonly volume: number;
	readonly colour: readonly [number, number, number] | null;
	readonly vertices: number;
	readonly triangles: number;
}

export interface CadTessellation {
	readonly deflection: number;
	readonly meshes: readonly CadMeshInfo[];
	readonly milliseconds: number;
}

export interface CadProperty {
	readonly name: string;
	readonly type: string;
	readonly group: string;
	readonly doc: string;
	readonly readOnly: boolean;
	readonly hidden: boolean;
	readonly value: unknown;
}

/** One object's mesh, read from a Mesh frame without copying. */
export interface CadMesh {
	readonly requestId: number;
	/** Index into the response's `meshes`. */
	readonly index: number;
	/** x, y, z per vertex (mm). */
	readonly positions: Float32Array;
	/** Three vertex indices per triangle. */
	readonly indices: Uint32Array;
	/** Triangles of B-rep face i ("Face{i+1}"): faceStart[i] … faceStart[i+1]-1. */
	readonly faceStart: Uint32Array;
	/** Points of edge i ("Edge{i+1}"): edgeStart[i] … edgeStart[i+1]-1. */
	readonly edgeStart: Uint32Array;
	/** x, y, z per edge point (mm). */
	readonly edgePoints: Float32Array;
}

export class CadProtocolError extends Error { }

/** Reads a Mesh frame's payload. The arrays view the payload's bytes. */
export function readMesh(payload: Uint8Array): CadMesh {
	if (payload.byteLength < MESH_HEADER || payload.byteOffset % 4 !== 0) {
		// Typed arrays need 4-byte alignment; copy when the frame isn't aligned.
		if (payload.byteLength >= MESH_HEADER) {
			return readMesh(payload.slice());
		}
		throw new CadProtocolError(`mesh frame of ${payload.byteLength} bytes is too short`);
	}
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const u32 = (offset: number) => view.getUint32(offset, true);
	if (u32(4) !== MESH_MAGIC) {
		throw new CadProtocolError(`not a mesh frame (magic ${u32(4).toString(16)})`);
	}
	const [vertices, triangles, faces, edges, edgePoints] = [u32(12), u32(16), u32(20), u32(24), u32(28)];
	const sizes = [vertices * 3, triangles * 3, faces + 1, edges + 1, edgePoints * 3];
	const total = MESH_HEADER + sizes.reduce((sum, size) => sum + size * 4, 0);
	if (total !== payload.byteLength) {
		throw new CadProtocolError(`mesh frame is ${payload.byteLength} bytes, its counts say ${total}`);
	}
	let offset = payload.byteOffset + MESH_HEADER;
	const take = <T>(make: (buffer: ArrayBufferLike, offset: number, length: number) => T, length: number): T => {
		const array = make(payload.buffer, offset, length);
		offset += length * 4;
		return array;
	};
	const f32 = (buffer: ArrayBufferLike, at: number, length: number) => new Float32Array(buffer, at, length);
	const u32s = (buffer: ArrayBufferLike, at: number, length: number) => new Uint32Array(buffer, at, length);
	return {
		requestId: u32(0),
		index: u32(8),
		positions: take(f32, sizes[0]),
		indices: take(u32s, sizes[1]),
		faceStart: take(u32s, sizes[2]),
		edgeStart: take(u32s, sizes[3]),
		edgePoints: take(f32, sizes[4]),
	};
}

/** The request id of a Mesh frame (to hand it to its request before parsing). */
export function meshRequestId(payload: Uint8Array): number {
	if (payload.byteLength < 4) {
		throw new CadProtocolError('mesh frame is too short');
	}
	return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRequest(id: number, method: string, params?: unknown): Uint8Array {
	const request: CadRequest = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
	return encoder.encode(JSON.stringify(request));
}

export function decodeResponse<T = unknown>(payload: Uint8Array): CadResponse<T> {
	const response = JSON.parse(decoder.decode(payload)) as CadResponse<T>;
	if (response === null || typeof response !== 'object' || response.jsonrpc !== '2.0') {
		throw new CadProtocolError('not a JSON-RPC 2.0 response');
	}
	return response;
}
