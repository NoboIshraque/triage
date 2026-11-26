/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The GPU side of the 3D tab (ROADMAP P2-3, PLAN §4.8): draws the CAD engine's
 *  meshes with WebGL2. FreeCAD's axes (Z up, mm). Each B-rep face is shaded smooth
 *  on its own (the engine sends no vertex twice across faces), so the edges between
 *  faces stay sharp; the faces' boundary edges are drawn as lines on top. Picking
 *  renders object and face ids into a one-pixel framebuffer under the cursor.
 *  No VS Code imports: tested headless (engines/cad/tests/render.mjs).
 *--------------------------------------------------------------------------------------------*/

import { CadMesh } from '../../common/cad/cadEngine.js';

/** What the view knows about one drawn object. */
export interface SceneObject {
	/** Stable key: "<document>/<object>". */
	readonly key: string;
	readonly mesh: CadMesh;
	/** 0..1 RGB; the renderer picks a neutral grey when undefined. */
	colour?: readonly [number, number, number];
	visible: boolean;
	selected: boolean;
	/** A fit or clearance problem (ROADMAP P2-5): drawn red. */
	problem: boolean;
	/** Faces to emphasise (problem faces), by index. */
	highlightFaces?: ReadonlySet<number>;
}

export interface OrbitCamera {
	/** The point the camera orbits around (mm). */
	target: [number, number, number];
	/** Degrees around Z, from the +Y axis looking towards -Y … */
	yaw: number;
	/** Degrees above the XY plane. */
	pitch: number;
	/** Distance from the target (mm). */
	distance: number;
	perspective: boolean;
}

export interface PickResult {
	readonly key: string;
	/** B-rep face index ("Face{face+1}"). */
	readonly face: number;
}

const MESH_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_viewProj;
uniform mat4 u_view;
// Fixed locations: the pick program shares this shader and the vertex layout.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_face;
out vec3 v_normal;
out vec3 v_viewPos;
flat out float v_face;
void main() {
	v_normal = mat3(u_view) * a_normal;
	v_viewPos = (u_view * vec4(a_pos, 1.0)).xyz;
	v_face = a_face;
	gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const MESH_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_colour;
uniform float u_tint;      // 0 none, 1 selected, 2 problem
uniform float u_highlightFace;
in vec3 v_normal;
in vec3 v_viewPos;
flat in float v_face;
out vec4 o_color;
void main() {
	vec3 n = normalize(v_normal);
	// Faces seen from behind (open shells, cut views) still light up.
	if (!gl_FrontFacing) { n = -n; }
	vec3 toEye = normalize(-v_viewPos);
	// A key light over the viewer's shoulder, a dimmer fill, and sky/ground ambient.
	vec3 key = normalize(vec3(0.35, 0.55, 1.0));
	vec3 fill = normalize(vec3(-0.6, -0.2, 0.5));
	float diffuse = max(dot(n, key), 0.0) * 0.75 + max(dot(n, fill), 0.0) * 0.25;
	float ambient = mix(0.18, 0.32, n.y * 0.5 + 0.5);
	float specular = pow(max(dot(reflect(-key, n), toEye), 0.0), 32.0) * 0.25;
	vec3 base = u_colour;
	if (u_tint > 1.5) {
		base = mix(base, vec3(0.95, 0.12, 0.10), 0.75);
		if (abs(v_face - u_highlightFace) < 0.5) { base = vec3(1.0, 0.25, 0.2); }
	} else if (u_tint > 0.5) {
		base = mix(base, vec3(1.0, 0.63, 0.12), 0.45);
	}
	o_color = vec4(base * (ambient + diffuse) + vec3(specular), 1.0);
}`;

const EDGE_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_viewProj;
layout(location = 0) in vec3 a_pos;
void main() {
	// Faces are pushed back by polygon offset, so their edges win the depth test.
	gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const EDGE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_colour;
out vec4 o_color;
void main() { o_color = u_colour; }`;

const PICK_FS = /* glsl */ `#version 300 es
precision highp float;
uniform uint u_object;
flat in float v_face;
in vec3 v_normal;
in vec3 v_viewPos;
out uvec4 o_id;
void main() { o_id = uvec4(u_object, uint(v_face), 0u, 0u); }`;

// The grid on the XY plane: lines every 10 mm, the axes coloured as in Blender.
const GRID_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_viewProj;
in vec3 a_pos;
in vec4 a_colour;
out vec4 v_colour;
void main() { v_colour = a_colour; gl_Position = u_viewProj * vec4(a_pos, 1.0); }`;

const GRID_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_colour;
out vec4 o_color;
void main() { o_color = v_colour; }`;

type Mat4 = Float32Array;

function perspective(fovyDeg: number, aspect: number, near: number, far: number): Mat4 {
	const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
	const m = new Float32Array(16);
	m[0] = f / aspect;
	m[5] = f;
	m[10] = (far + near) / (near - far);
	m[11] = -1;
	m[14] = (2 * far * near) / (near - far);
	return m;
}

function orthographic(halfHeight: number, aspect: number, near: number, far: number): Mat4 {
	const m = new Float32Array(16);
	m[0] = 1 / (halfHeight * aspect);
	m[5] = 1 / halfHeight;
	m[10] = -2 / (far - near);
	m[14] = -(far + near) / (far - near);
	m[15] = 1;
	return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				sum += a[k * 4 + row] * b[col * 4 + k];
			}
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

/** The camera's position and basis (right, up, forward) in world space. */
export function cameraFrame(camera: OrbitCamera): { eye: number[]; right: number[]; up: number[]; forward: number[] } {
	const yaw = (camera.yaw * Math.PI) / 180;
	const pitch = (camera.pitch * Math.PI) / 180;
	// Direction from the target to the eye: yaw 0 looks from -Y (FreeCAD's front view).
	const back = [Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
	const eye = camera.target.map((t, i) => t + back[i] * camera.distance);
	const forward = back.map(v => -v);
	const worldUp = Math.abs(pitch) > Math.PI / 2 - 1e-3 ? [Math.sin(yaw) * -Math.sign(pitch), Math.cos(yaw) * Math.sign(pitch), 0] : [0, 0, 1];
	const right = normalize(cross(forward, worldUp));
	const up = cross(right, forward);
	return { eye, right, up, forward };
}

function cross(a: number[], b: number[]): number[] {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: number[]): number[] {
	const length = Math.hypot(v[0], v[1], v[2]) || 1;
	return v.map(x => x / length);
}

function lookAt(camera: OrbitCamera): Mat4 {
	const { eye, right, up, forward } = cameraFrame(camera);
	const m = new Float32Array(16);
	m[0] = right[0]; m[4] = right[1]; m[8] = right[2];
	m[1] = up[0]; m[5] = up[1]; m[9] = up[2];
	m[2] = -forward[0]; m[6] = -forward[1]; m[10] = -forward[2];
	m[12] = -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]);
	m[13] = -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]);
	m[14] = forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2];
	m[15] = 1;
	return m;
}

/** Normals per vertex, smooth within each B-rep face (vertices aren't shared across faces). */
export function faceNormals(mesh: CadMesh): Float32Array {
	const { positions, indices } = mesh;
	const normals = new Float32Array(positions.length);
	for (let t = 0; t < indices.length; t += 3) {
		const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
		const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
		const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
		// Area-weighted: the cross product's length is twice the triangle's area.
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for (const v of [a, b, c]) {
			normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz;
		}
	}
	for (let i = 0; i < normals.length; i += 3) {
		const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
		normals[i] /= length; normals[i + 1] /= length; normals[i + 2] /= length;
	}
	return normals;
}

/** The B-rep face of every vertex (for picking and highlights). */
export function vertexFaces(mesh: CadMesh): Float32Array {
	const faces = new Float32Array(mesh.positions.length / 3);
	for (let f = 0; f + 1 < mesh.faceStart.length; f++) {
		for (let t = mesh.faceStart[f]; t < mesh.faceStart[f + 1]; t++) {
			for (let k = 0; k < 3; k++) {
				faces[mesh.indices[t * 3 + k]] = f;
			}
		}
	}
	return faces;
}

/** Edge polylines as line segments (pairs of points). */
export function edgeSegments(mesh: CadMesh): Float32Array {
	let count = 0;
	for (let e = 0; e + 1 < mesh.edgeStart.length; e++) {
		count += Math.max(0, mesh.edgeStart[e + 1] - mesh.edgeStart[e] - 1);
	}
	const out = new Float32Array(count * 6);
	let o = 0;
	for (let e = 0; e + 1 < mesh.edgeStart.length; e++) {
		for (let p = mesh.edgeStart[e]; p + 1 < mesh.edgeStart[e + 1]; p++) {
			out.set(mesh.edgePoints.subarray(p * 3, p * 3 + 6), o);
			o += 6;
		}
	}
	return out;
}

interface GpuObject {
	readonly object: SceneObject;
	readonly vao: WebGLVertexArrayObject;
	readonly buffers: WebGLBuffer[];
	readonly count: number;
	readonly edgeVao: WebGLVertexArrayObject;
	readonly edgeCount: number;
	readonly box: [number, number, number, number, number, number];
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
	const program = gl.createProgram()!;
	for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			throw new Error(`3D view shader: ${gl.getShaderInfoLog(shader)}`);
		}
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`3D view program: ${gl.getProgramInfoLog(program)}`);
	}
	return program;
}

export class CadRenderer {
	private readonly gl: WebGL2RenderingContext;
	private readonly meshProgram: WebGLProgram;
	private readonly edgeProgram: WebGLProgram;
	private readonly pickProgram: WebGLProgram;
	private readonly gridProgram: WebGLProgram;
	private readonly objects = new Map<string, GpuObject>();
	private gridVao: WebGLVertexArrayObject | undefined;
	private gridCount = 0;
	private pickTarget: { fb: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer; width: number; height: number } | undefined;
	private viewProj: Mat4 = new Float32Array(16);
	private view: Mat4 = new Float32Array(16);
	readonly camera: OrbitCamera = { target: [0, 0, 0], yaw: 30, pitch: 25, distance: 200, perspective: true };
	background: readonly [number, number, number] = [0.16, 0.17, 0.19];
	gridVisible = true;

	constructor(readonly canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
		if (!gl) {
			throw new Error('WebGL2 is not available');
		}
		this.gl = gl;
		this.meshProgram = compile(gl, MESH_VS, MESH_FS);
		this.edgeProgram = compile(gl, EDGE_VS, EDGE_FS);
		this.pickProgram = compile(gl, MESH_VS, PICK_FS);
		this.gridProgram = compile(gl, GRID_VS, GRID_FS);
		this.buildGrid(500, 10);
	}

	/** Adds or replaces an object's mesh on the GPU. */
	setObject(object: SceneObject): void {
		this.removeObject(object.key);
		const gl = this.gl;
		const mesh = object.mesh;
		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		const buffers: WebGLBuffer[] = [];
		const attribute = (location: number, data: Float32Array, size: number) => {
			const buffer = gl.createBuffer()!;
			buffers.push(buffer);
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
			gl.enableVertexAttribArray(location);
			gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
		};
		// The mesh and pick programs share their vertex shader (locations 0, 1, 2).
		attribute(0, mesh.positions, 3);
		attribute(1, faceNormals(mesh), 3);
		attribute(2, vertexFaces(mesh), 1);
		const index = gl.createBuffer()!;
		buffers.push(index);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

		const edgeVao = gl.createVertexArray()!;
		gl.bindVertexArray(edgeVao);
		const segments = edgeSegments(mesh);
		const edgeBuffer = gl.createBuffer()!;
		buffers.push(edgeBuffer);
		gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		const box: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
		for (let i = 0; i < mesh.positions.length; i += 3) {
			for (let k = 0; k < 3; k++) {
				box[k] = Math.min(box[k], mesh.positions[i + k]);
				box[k + 3] = Math.max(box[k + 3], mesh.positions[i + k]);
			}
		}
		this.objects.set(object.key, { object, vao, buffers, count: mesh.indices.length, edgeVao, edgeCount: segments.length / 3, box });
	}

	removeObject(key: string): void {
		const gpu = this.objects.get(key);
		if (!gpu) {
			return;
		}
		const gl = this.gl;
		gl.deleteVertexArray(gpu.vao);
		gl.deleteVertexArray(gpu.edgeVao);
		for (const buffer of gpu.buffers) {
			gl.deleteBuffer(buffer);
		}
		this.objects.delete(key);
	}

	/** Removes every object whose key starts with `prefix` ("<document>/"). */
	removeObjects(prefix: string): void {
		for (const key of [...this.objects.keys()]) {
			if (key.startsWith(prefix)) {
				this.removeObject(key);
			}
		}
	}

	get sceneObjects(): SceneObject[] {
		return [...this.objects.values()].map(gpu => gpu.object);
	}

	getObject(key: string): SceneObject | undefined {
		return this.objects.get(key)?.object;
	}

	/** The bounding box of the visible objects (or the given ones). */
	bounds(keys?: readonly string[]): [number, number, number, number, number, number] | undefined {
		const box: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
		for (const [key, gpu] of this.objects) {
			if ((keys && !keys.includes(key)) || (!keys && !gpu.object.visible)) {
				continue;
			}
			for (let k = 0; k < 3; k++) {
				box[k] = Math.min(box[k], gpu.box[k]);
				box[k + 3] = Math.max(box[k + 3], gpu.box[k + 3]);
			}
		}
		return box[0] <= box[3] ? box : undefined;
	}

	/** Moves the camera so `box` fills the view, keeping its direction. */
	frame(box = this.bounds()): void {
		if (!box) {
			return;
		}
		this.camera.target = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
		const radius = Math.max(1, Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2);
		this.camera.distance = radius / Math.sin((22.5 * Math.PI) / 180) * 1.05;
	}

	/** Orbits by screen pixels (Blender: middle-drag). */
	orbit(dx: number, dy: number): void {
		this.camera.yaw = (this.camera.yaw - dx * 0.4) % 360;
		this.camera.pitch = Math.max(-89.9, Math.min(89.9, this.camera.pitch + dy * 0.4));
	}

	/** Pans by screen pixels (Blender: Shift + middle-drag). */
	pan(dx: number, dy: number): void {
		const { right, up } = cameraFrame(this.camera);
		const height = this.canvas.clientHeight || 1;
		const worldPerPixel = (2 * this.camera.distance * Math.tan((22.5 * Math.PI) / 180)) / height;
		for (let k = 0; k < 3; k++) {
			this.camera.target[k] += (-dx * right[k] + dy * up[k]) * worldPerPixel;
		}
	}

	/** Zooms towards the target (Blender: wheel, Ctrl + middle-drag). */
	zoom(factor: number): void {
		this.camera.distance = Math.max(0.5, Math.min(1e6, this.camera.distance * factor));
	}

	/** Standard views (Blender's numpad): front, back, right, left, top, bottom. */
	setView(view: 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'iso'): void {
		const views = { front: [0, 0], back: [180, 0], right: [90, 0], left: [-90, 0], top: [0, 89.9], bottom: [0, -89.9], iso: [30, 25] } as const;
		[this.camera.yaw, this.camera.pitch] = views[view];
	}

	private matrices(width: number, height: number): void {
		const aspect = width / Math.max(1, height);
		// Near and far planes around what is drawn, for depth precision: a 24-bit depth
		// buffer spread over metres can't tell a 1.6 mm board's faces apart.
		const box = this.bounds();
		const radius = box ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2 : 100;
		const far = this.camera.distance + Math.max(radius, 10) * 4 + 1000;
		const near = Math.max(0.05, Math.min(this.camera.distance - radius * 1.5, this.camera.distance * 0.5), far / 1e5);
		const projection = this.camera.perspective
			? perspective(45, aspect, near, far)
			: orthographic(this.camera.distance * Math.tan((22.5 * Math.PI) / 180), aspect, -far, far);
		this.view = lookAt(this.camera);
		this.viewProj = multiply(projection, this.view);
	}

	/** Draws the scene; returns the milliseconds the CPU side took. */
	render(): number {
		const started = performance.now();
		const gl = this.gl;
		const dpr = globalThis.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		gl.viewport(0, 0, width, height);
		gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.CULL_FACE);
		this.matrices(width, height);

		if (this.gridVisible && this.gridVao) {
			gl.useProgram(this.gridProgram);
			gl.uniformMatrix4fv(gl.getUniformLocation(this.gridProgram, 'u_viewProj'), false, this.viewProj);
			gl.bindVertexArray(this.gridVao);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			gl.drawArrays(gl.LINES, 0, this.gridCount);
			gl.disable(gl.BLEND);
		}

		gl.useProgram(this.meshProgram);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProgram, 'u_viewProj'), false, this.viewProj);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProgram, 'u_view'), false, this.view);
		const colourAt = gl.getUniformLocation(this.meshProgram, 'u_colour');
		const tintAt = gl.getUniformLocation(this.meshProgram, 'u_tint');
		const faceAt = gl.getUniformLocation(this.meshProgram, 'u_highlightFace');
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(1.5, 2);
		for (const gpu of this.objects.values()) {
			const object = gpu.object;
			if (!object.visible) {
				continue;
			}
			const colour = object.colour ?? [0.62, 0.64, 0.68];
			gl.uniform3f(colourAt, colour[0], colour[1], colour[2]);
			gl.uniform1f(tintAt, object.problem ? 2 : object.selected ? 1 : 0);
			const highlight = object.highlightFaces && object.highlightFaces.size > 0 ? [...object.highlightFaces][0] : -1;
			gl.uniform1f(faceAt, highlight);
			gl.bindVertexArray(gpu.vao);
			gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
		}
		gl.disable(gl.POLYGON_OFFSET_FILL);

		gl.useProgram(this.edgeProgram);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.edgeProgram, 'u_viewProj'), false, this.viewProj);
		const edgeColourAt = gl.getUniformLocation(this.edgeProgram, 'u_colour');
		for (const gpu of this.objects.values()) {
			if (!gpu.object.visible || gpu.edgeCount === 0) {
				continue;
			}
			if (gpu.object.selected) {
				gl.uniform4f(edgeColourAt, 1.0, 0.6, 0.1, 1);
			} else {
				gl.uniform4f(edgeColourAt, 0.05, 0.05, 0.06, 1);
			}
			gl.bindVertexArray(gpu.edgeVao);
			gl.drawArrays(gl.LINES, 0, gpu.edgeCount);
		}
		gl.bindVertexArray(null);
		return performance.now() - started;
	}

	/** The object and face under a CSS-pixel position, if any. */
	pick(x: number, y: number): PickResult | undefined {
		const gl = this.gl;
		const width = this.canvas.width;
		const height = this.canvas.height;
		const target = this.pickBuffer(width, height);
		const dpr = width / Math.max(1, this.canvas.clientWidth);
		const px = Math.floor(x * dpr);
		const py = height - 1 - Math.floor(y * dpr);
		if (px < 0 || py < 0 || px >= width || py >= height) {
			return undefined;
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
		gl.viewport(0, 0, width, height);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(px, py, 1, 1);
		gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
		gl.clear(gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		this.matrices(width, height);
		gl.useProgram(this.pickProgram);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.pickProgram, 'u_viewProj'), false, this.viewProj);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.pickProgram, 'u_view'), false, this.view);
		const objectAt = gl.getUniformLocation(this.pickProgram, 'u_object');
		const keys: string[] = [];
		for (const gpu of this.objects.values()) {
			if (!gpu.object.visible) {
				continue;
			}
			keys.push(gpu.object.key);
			gl.uniform1ui(objectAt, keys.length);
			gl.bindVertexArray(gpu.vao);
			gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
		}
		const out = new Uint32Array(4);
		gl.readPixels(px, py, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
		gl.disable(gl.SCISSOR_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.bindVertexArray(null);
		return out[0] > 0 ? { key: keys[out[0] - 1], face: out[1] } : undefined;
	}

	private pickBuffer(width: number, height: number) {
		const gl = this.gl;
		if (this.pickTarget && this.pickTarget.width === width && this.pickTarget.height === height) {
			return this.pickTarget;
		}
		if (this.pickTarget) {
			gl.deleteFramebuffer(this.pickTarget.fb);
			gl.deleteTexture(this.pickTarget.tex);
			gl.deleteRenderbuffer(this.pickTarget.depth);
		}
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
		const depth = gl.createRenderbuffer()!;
		gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
		const fb = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.pickTarget = { fb, tex, depth, width, height };
		return this.pickTarget;
	}

	private buildGrid(half: number, step: number): void {
		const gl = this.gl;
		const data: number[] = [];
		// Each line in pieces one step long: a line that passes behind the camera is
		// dropped whole by some GL implementations (observed under SwiftShader) instead
		// of being clipped, so only the pieces behind the camera may go.
		const line = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
			const pieces = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
			for (let i = 0; i < pieces; i++) {
				const a = i / pieces, b = (i + 1) / pieces;
				data.push(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, 0, ...c, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, 0, ...c);
			}
		};
		for (let v = -half; v <= half; v += step) {
			const major = v % (step * 10) === 0;
			const colour = major ? [1, 1, 1, 0.2] : [1, 1, 1, 0.09];
			if (v !== 0) {
				line(v, -half, v, half, colour);
				line(-half, v, half, v, colour);
			}
		}
		line(-half, 0, half, 0, [0.9, 0.3, 0.33, 0.8]); // X: red
		line(0, -half, 0, half, [0.55, 0.8, 0.2, 0.8]); // Y: green
		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		const buffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
		const pos = gl.getAttribLocation(this.gridProgram, 'a_pos');
		const colour = gl.getAttribLocation(this.gridProgram, 'a_colour');
		gl.enableVertexAttribArray(pos);
		gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 28, 0);
		gl.enableVertexAttribArray(colour);
		gl.vertexAttribPointer(colour, 4, gl.FLOAT, false, 28, 12);
		gl.bindVertexArray(null);
		this.gridVao = vao;
		this.gridCount = data.length / 7;
	}

	dispose(): void {
		for (const key of [...this.objects.keys()]) {
			this.removeObject(key);
		}
		const gl = this.gl;
		gl.deleteProgram(this.meshProgram);
		gl.deleteProgram(this.edgeProgram);
		gl.deleteProgram(this.pickProgram);
		gl.deleteProgram(this.gridProgram);
	}
}
