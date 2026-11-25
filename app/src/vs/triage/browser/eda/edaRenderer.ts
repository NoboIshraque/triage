/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The GPU side of the Schematic and Board tabs (ROADMAP P1-4, PLAN §4.8): draws
 *  the Stream GAL's display lists with WebGL2. Each layer keeps four buffers:
 *  triangles, and instanced capsules (segments), circles and arcs whose edges the
 *  fragment shader computes exactly, as KiCad's OpenGL GAL does with its shaders.
 *  Layers are drawn back to front in KiCad's rendering order; a group is hidden
 *  while the view is zoomed out below its level of detail (VIEW_ITEM::ViewGetLOD).
 *  No VS Code imports beyond the display-list model: tested headless.
 *--------------------------------------------------------------------------------------------*/

import { DisplayGroup, DisplayListModel, FLOATS_PER, PrimitiveKind } from '../../common/eda/displayList.js';

export interface Camera {
	/** World coordinates (KiCad internal units) at the centre of the canvas. */
	cx: number;
	cy: number;
	/** CSS pixels per world unit. */
	scale: number;
}

export interface LayerStyle {
	readonly id: number;
	/** KiCad's rendering order: lower is nearer the viewer. */
	readonly order: number;
	visible: boolean;
}

// Instance layouts (floats): segment x1 y1 x2 y2 w lod rgba; circle cx cy r w lod rgba;
// arc cx cy r a0 a1 w lod rgba. Triangles: x y lod rgba per vertex. rgba is a uint32
// in the same interleaved buffer (an integer attribute).
const SEG_STRIDE = 7;
const CIRCLE_STRIDE = 6;
const ARC_STRIDE = 8;
const TRI_STRIDE = 4;

const COMMON = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_center;     // world
uniform vec2 u_halfSize;   // canvas half size in CSS pixels
uniform float u_scale;     // CSS pixels per world unit
uniform float u_viewScale; // KiCad VIEW scale, for levels of detail
uniform float u_minWidth;  // thinnest line in world units (one device pixel)
vec4 toClip(vec2 world) {
	vec2 px = (world - u_center) * u_scale;
	return vec4(px.x / u_halfSize.x, -px.y / u_halfSize.y, 0.0, 1.0);
}
vec4 unpackColor(uint c) {
	return vec4(float((c >> 24) & 255u), float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u)) / 255.0;
}
`;

const TRI_VS = COMMON + /* glsl */ `
in vec2 a_pos;
in float a_lod;
in uint a_rgba;
out vec4 v_color;
void main() {
	v_color = unpackColor(a_rgba);
	gl_Position = a_lod < u_viewScale ? toClip(a_pos) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const TRI_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o_color;
void main() { o_color = vec4(v_color.rgb * v_color.a, v_color.a); }`;

// Quad corners for the instanced primitives.
const CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

const SEG_VS = COMMON + /* glsl */ `
in vec2 a_corner;
in vec4 a_ends;   // x1 y1 x2 y2
in float a_width;
in float a_lod;
in uint a_rgba;
out vec2 v_world;
flat out vec4 v_ends;
flat out float v_half;
flat out vec4 v_color;
void main() {
	float half_ = max(a_width, u_minWidth) * 0.5;
	vec2 a = a_ends.xy, b = a_ends.zw;
	vec2 d = b - a;
	float len = length(d);
	vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
	vec2 nrm = vec2(-dir.y, dir.x);
	float pad = half_ + 1.5 / u_scale;
	vec2 mid = (a + b) * 0.5;
	vec2 p = mid + dir * a_corner.x * (len * 0.5 + pad) + nrm * a_corner.y * pad;
	v_world = p;
	v_ends = a_ends;
	v_half = half_;
	v_color = unpackColor(a_rgba);
	gl_Position = a_lod < u_viewScale ? toClip(p) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const EDGE = /* glsl */ `
float coverage(float dist) {
	// dist: signed distance to the edge in world units (negative inside).
	float px = dist * u_scale;
	return clamp(0.5 - px, 0.0, 1.0);
}`;

const SEG_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_scale;
in vec2 v_world;
flat in vec4 v_ends;
flat in float v_half;
flat in vec4 v_color;
out vec4 o_color;
` + EDGE + /* glsl */ `
void main() {
	vec2 a = v_ends.xy, b = v_ends.zw;
	vec2 pa = v_world - a, ba = b - a;
	float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
	float dist = length(pa - ba * h) - v_half;
	float alpha = v_color.a * coverage(dist);
	if (alpha <= 0.0) { discard; }
	o_color = vec4(v_color.rgb * alpha, alpha);
}`;

const CIRCLE_VS = COMMON + /* glsl */ `
in vec2 a_corner;
in vec3 a_circle; // cx cy r
in float a_width; // 0: filled disc
in float a_lod;
in uint a_rgba;
out vec2 v_world;
flat out vec3 v_circle;
flat out float v_half;
flat out vec4 v_color;
void main() {
	float half_ = a_width > 0.0 ? max(a_width, u_minWidth) * 0.5 : 0.0;
	float r = max(a_circle.z, a_width > 0.0 ? 0.0 : u_minWidth * 0.5);
	float extent = r + half_ + 1.5 / u_scale;
	vec2 p = a_circle.xy + a_corner * extent;
	v_world = p;
	v_circle = vec3(a_circle.xy, r);
	v_half = half_;
	v_color = unpackColor(a_rgba);
	gl_Position = a_lod < u_viewScale ? toClip(p) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const CIRCLE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_scale;
in vec2 v_world;
flat in vec3 v_circle;
flat in float v_half;
flat in vec4 v_color;
out vec4 o_color;
` + EDGE + /* glsl */ `
void main() {
	float d = length(v_world - v_circle.xy);
	float dist = v_half > 0.0 ? abs(d - v_circle.z) - v_half : d - v_circle.z;
	float alpha = v_color.a * coverage(dist);
	if (alpha <= 0.0) { discard; }
	o_color = vec4(v_color.rgb * alpha, alpha);
}`;

const ARC_VS = COMMON + /* glsl */ `
in vec2 a_corner;
in vec3 a_circle; // cx cy r
in vec2 a_angles; // start, end (end >= start)
in float a_width;
in float a_lod;
in uint a_rgba;
out vec2 v_world;
flat out vec3 v_circle;
flat out vec2 v_angles;
flat out float v_half;
flat out vec4 v_color;
void main() {
	float half_ = max(a_width, u_minWidth) * 0.5;
	float extent = a_circle.z + half_ + 1.5 / u_scale;
	vec2 p = a_circle.xy + a_corner * extent;
	v_world = p;
	v_circle = a_circle;
	v_angles = a_angles;
	v_half = half_;
	v_color = unpackColor(a_rgba);
	gl_Position = a_lod < u_viewScale ? toClip(p) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const ARC_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_scale;
in vec2 v_world;
flat in vec3 v_circle;
flat in vec2 v_angles;
flat in float v_half;
flat in vec4 v_color;
out vec4 o_color;
const float TAU = 6.283185307179586;
` + EDGE + /* glsl */ `
void main() {
	vec2 q = v_world - v_circle.xy;
	float r = v_circle.z;
	float a = atan(q.y, q.x);
	// Bring the angle into [start, start + 2pi).
	a = v_angles.x + mod(a - v_angles.x, TAU);
	float dist;
	if (a <= v_angles.y) {
		dist = abs(length(q) - r) - v_half;
	} else {
		vec2 s = r * vec2(cos(v_angles.x), sin(v_angles.x));
		vec2 e = r * vec2(cos(v_angles.y), sin(v_angles.y));
		dist = min(length(q - s), length(q - e)) - v_half;
	}
	float alpha = v_color.a * coverage(dist);
	if (alpha <= 0.0) { discard; }
	o_color = vec4(v_color.rgb * alpha, alpha);
}`;

interface Program {
	readonly program: WebGLProgram;
	readonly uniforms: Record<string, WebGLUniformLocation | null>;
	readonly attributes: Record<string, number>;
}

interface LayerBuffers {
	tri?: WebGLVertexArrayObject; triBuffer?: WebGLBuffer; triCount: number;
	seg?: WebGLVertexArrayObject; segBuffer?: WebGLBuffer; segCount: number;
	circle?: WebGLVertexArrayObject; circleBuffer?: WebGLBuffer; circleCount: number;
	arc?: WebGLVertexArrayObject; arcBuffer?: WebGLBuffer; arcCount: number;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, attributes: string[], uniforms: string[]): Program {
	const shader = (type: number, source: string) => {
		const s = gl.createShader(type)!;
		gl.shaderSource(s, source);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
		}
		return s;
	};
	const program = gl.createProgram()!;
	gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
	gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
	}
	const u: Record<string, WebGLUniformLocation | null> = {};
	for (const name of uniforms) {
		u[name] = gl.getUniformLocation(program, name);
	}
	const a: Record<string, number> = {};
	for (const name of attributes) {
		a[name] = gl.getAttribLocation(program, name);
	}
	return { program, uniforms: u, attributes: a };
}

const UNIFORMS = ['u_center', 'u_halfSize', 'u_scale', 'u_viewScale', 'u_minWidth'];

export interface FrameStats {
	readonly milliseconds: number;
	readonly drawCalls: number;
	readonly primitives: number;
}

export class EdaRenderer {
	private readonly gl: WebGL2RenderingContext;
	private readonly tri: Program;
	private readonly seg: Program;
	private readonly circle: Program;
	private readonly arc: Program;
	private readonly corners: WebGLBuffer;
	private readonly layers = new Map<number, LayerBuffers>();
	private styles = new Map<number, LayerStyle>();
	private background = [0, 0, 0, 1];
	/** VIEW scale = CSS pixels per world unit / this (DocumentInfo.pixels_per_iu_at_scale_1). */
	pixelsPerIuAtScale1 = 1;

	constructor(readonly canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true });
		if (!gl) {
			throw new Error('WebGL2 is not available');
		}
		this.gl = gl;
		this.tri = compile(gl, TRI_VS, TRI_FS, ['a_pos', 'a_lod', 'a_rgba'], UNIFORMS);
		this.seg = compile(gl, SEG_VS, SEG_FS, ['a_corner', 'a_ends', 'a_width', 'a_lod', 'a_rgba'], UNIFORMS);
		this.circle = compile(gl, CIRCLE_VS, CIRCLE_FS, ['a_corner', 'a_circle', 'a_width', 'a_lod', 'a_rgba'], UNIFORMS);
		this.arc = compile(gl, ARC_VS, ARC_FS, ['a_corner', 'a_circle', 'a_angles', 'a_width', 'a_lod', 'a_rgba'], UNIFORMS);
		this.corners = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
		gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
	}

	setBackground(rgba: number): void {
		this.background = [((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255, ((rgba >>> 8) & 255) / 255, 1];
	}

	setLayers(styles: Iterable<LayerStyle>): void {
		this.styles = new Map([...styles].map(style => [style.id, style]));
	}

	/** Rebuilds the GPU buffers of `layers` from the model. */
	updateLayers(model: DisplayListModel, layers: Iterable<number>): void {
		for (const layer of layers) {
			const ids = model.byLayer.get(layer);
			const groups: DisplayGroup[] = [];
			for (const id of ids ?? []) {
				const group = model.groups.get(id);
				if (group) {
					groups.push(group);
				}
			}
			this.buildLayer(layer, groups);
		}
	}

	private buildLayer(layer: number, groups: DisplayGroup[]): void {
		const gl = this.gl;
		let tris = 0, segs = 0, circles = 0, arcs = 0;
		for (const group of groups) {
			for (const run of group.runs) {
				const n = run.data.length / FLOATS_PER[run.kind];
				switch (run.kind) {
					case PrimitiveKind.Triangles: tris += n; break;
					case PrimitiveKind.Segments: segs += n; break;
					case PrimitiveKind.Circles: circles += n; break;
					case PrimitiveKind.Arcs: arcs += n; break;
				}
			}
		}
		const tri = new Float32Array(tris * TRI_STRIDE);
		const seg = new Float32Array(segs * SEG_STRIDE);
		const circ = new Float32Array(circles * CIRCLE_STRIDE);
		const arc = new Float32Array(arcs * ARC_STRIDE);
		const triU = new Uint32Array(tri.buffer);
		const segU = new Uint32Array(seg.buffer);
		const circU = new Uint32Array(circ.buffer);
		const arcU = new Uint32Array(arc.buffer);
		let ti = 0, si = 0, ci = 0, ai = 0;
		for (const group of groups) {
			const lod = group.lod;
			for (const run of group.runs) {
				const color = (group.overrideRgba ?? run.rgba) >>> 0;
				const d = run.data;
				switch (run.kind) {
					case PrimitiveKind.Triangles:
						for (let i = 0; i < d.length; i += 2) {
							tri[ti++] = d[i]; tri[ti++] = d[i + 1]; tri[ti++] = lod; triU[ti++] = color;
						}
						break;
					case PrimitiveKind.Segments:
						for (let i = 0; i < d.length; i += 5) {
							seg[si++] = d[i]; seg[si++] = d[i + 1]; seg[si++] = d[i + 2]; seg[si++] = d[i + 3];
							seg[si++] = d[i + 4]; seg[si++] = lod; segU[si++] = color;
						}
						break;
					case PrimitiveKind.Circles:
						for (let i = 0; i < d.length; i += 4) {
							circ[ci++] = d[i]; circ[ci++] = d[i + 1]; circ[ci++] = d[i + 2]; circ[ci++] = d[i + 3];
							circ[ci++] = lod; circU[ci++] = color;
						}
						break;
					case PrimitiveKind.Arcs:
						for (let i = 0; i < d.length; i += 6) {
							arc[ai++] = d[i]; arc[ai++] = d[i + 1]; arc[ai++] = d[i + 2]; arc[ai++] = d[i + 3];
							arc[ai++] = d[i + 4]; arc[ai++] = d[i + 5]; arc[ai++] = lod; arcU[ai++] = color;
						}
						break;
				}
			}
		}

		const old = this.layers.get(layer);
		if (old) {
			this.release(old);
		}
		const buffers: LayerBuffers = { triCount: tris, segCount: segs, circleCount: circles, arcCount: arcs };
		const f = 4;
		if (tris > 0) {
			[buffers.tri, buffers.triBuffer] = this.vao(this.tri, tri, false, TRI_STRIDE * f, [['a_pos', 2, 0], ['a_lod', 1, 2], ['a_rgba', 1, 3]]);
		}
		if (segs > 0) {
			[buffers.seg, buffers.segBuffer] = this.vao(this.seg, seg, true, SEG_STRIDE * f, [['a_ends', 4, 0], ['a_width', 1, 4], ['a_lod', 1, 5], ['a_rgba', 1, 6]]);
		}
		if (circles > 0) {
			[buffers.circle, buffers.circleBuffer] = this.vao(this.circle, circ, true, CIRCLE_STRIDE * f, [['a_circle', 3, 0], ['a_width', 1, 3], ['a_lod', 1, 4], ['a_rgba', 1, 5]]);
		}
		if (arcs > 0) {
			[buffers.arc, buffers.arcBuffer] = this.vao(this.arc, arc, true, ARC_STRIDE * f, [['a_circle', 3, 0], ['a_angles', 2, 3], ['a_width', 1, 5], ['a_lod', 1, 6], ['a_rgba', 1, 7]]);
		}
		gl.bindVertexArray(null);
		if (tris + segs + circles + arcs > 0) {
			this.layers.set(layer, buffers);
		} else {
			this.layers.delete(layer);
		}
	}

	private vao(program: Program, data: Float32Array, instanced: boolean, stride: number, attributes: [string, number, number][]): [WebGLVertexArrayObject, WebGLBuffer] {
		const gl = this.gl;
		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		if (instanced) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
			const corner = program.attributes['a_corner'];
			gl.enableVertexAttribArray(corner);
			gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
		}
		const buffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
		for (const [name, size, offset] of attributes) {
			const location = program.attributes[name];
			if (location < 0) {
				continue;
			}
			gl.enableVertexAttribArray(location);
			if (name === 'a_rgba') {
				gl.vertexAttribIPointer(location, size, gl.UNSIGNED_INT, stride, offset * 4);
			} else {
				gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
			}
			if (instanced) {
				gl.vertexAttribDivisor(location, 1);
			}
		}
		return [vao, buffer];
	}

	private release(buffers: LayerBuffers): void {
		const gl = this.gl;
		for (const vao of [buffers.tri, buffers.seg, buffers.circle, buffers.arc]) {
			if (vao) {
				gl.deleteVertexArray(vao);
			}
		}
		for (const buffer of [buffers.triBuffer, buffers.segBuffer, buffers.circleBuffer, buffers.arcBuffer]) {
			if (buffer) {
				gl.deleteBuffer(buffer);
			}
		}
	}

	clear(): void {
		for (const buffers of this.layers.values()) {
			this.release(buffers);
		}
		this.layers.clear();
	}

	/** Draws one frame. `width` and `height` are CSS pixels; `ratio` device pixels per CSS pixel. */
	draw(camera: Camera, width: number, height: number, ratio: number): FrameStats {
		const started = performance.now();
		const gl = this.gl;
		const pixelWidth = Math.max(1, Math.round(width * ratio));
		const pixelHeight = Math.max(1, Math.round(height * ratio));
		if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
			this.canvas.width = pixelWidth;
			this.canvas.height = pixelHeight;
		}
		gl.viewport(0, 0, pixelWidth, pixelHeight);
		gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		const viewScale = camera.scale / this.pixelsPerIuAtScale1;
		const minWidth = 1 / (camera.scale * ratio);
		const programs = [this.tri, this.seg, this.circle, this.arc];
		for (const program of programs) {
			gl.useProgram(program.program);
			gl.uniform2f(program.uniforms['u_center'], camera.cx, camera.cy);
			gl.uniform2f(program.uniforms['u_halfSize'], width / 2, height / 2);
			gl.uniform1f(program.uniforms['u_scale'], camera.scale);
			gl.uniform1f(program.uniforms['u_viewScale'], viewScale);
			gl.uniform1f(program.uniforms['u_minWidth'], minWidth);
		}

		// Back to front: higher rendering order first (KiCad's VIEW does the same).
		const ordered = [...this.layers.keys()]
			.filter(layer => this.styles.get(layer)?.visible ?? true)
			.sort((a, b) => (this.styles.get(b)?.order ?? 0) - (this.styles.get(a)?.order ?? 0));

		let drawCalls = 0;
		let primitives = 0;
		for (const layer of ordered) {
			const buffers = this.layers.get(layer)!;
			if (buffers.tri) {
				gl.useProgram(this.tri.program);
				gl.bindVertexArray(buffers.tri);
				gl.drawArrays(gl.TRIANGLES, 0, buffers.triCount);
				drawCalls++;
				primitives += buffers.triCount / 3;
			}
			const instanced: [Program, WebGLVertexArrayObject | undefined, number][] = [
				[this.seg, buffers.seg, buffers.segCount],
				[this.circle, buffers.circle, buffers.circleCount],
				[this.arc, buffers.arc, buffers.arcCount],
			];
			for (const [program, vao, count] of instanced) {
				if (vao) {
					gl.useProgram(program.program);
					gl.bindVertexArray(vao);
					gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
					drawCalls++;
					primitives += count;
				}
			}
		}
		gl.bindVertexArray(null);
		return { milliseconds: performance.now() - started, drawCalls, primitives };
	}

	dispose(): void {
		this.clear();
		const gl = this.gl;
		gl.deleteBuffer(this.corners);
		for (const program of [this.tri, this.seg, this.circle, this.arc]) {
			gl.deleteProgram(program.program);
		}
	}
}
