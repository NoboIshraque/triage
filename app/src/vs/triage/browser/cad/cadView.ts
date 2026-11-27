/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The 3D tab (ROADMAP P2-3): the project's FreeCAD documents and its circuit board,
 *  drawn together from the CAD engine's meshes on Triage's WebGL2 canvas, with an
 *  outliner and a properties panel. The board comes from the KiCad engine's live
 *  board (GetBoard3D), built into solids by the CAD engine (board.update), and is
 *  rebuilt whenever the board changes in the Board tab or on disk.
 *
 *  Navigation as in Blender: middle drag orbits, Shift + middle drag pans, Ctrl +
 *  middle drag or the wheel zooms; Alt + left drag orbits and Shift + Alt + left drag
 *  pans for laptops without a middle button. Numpad 1, 3 and 7 look from the front,
 *  the right and the top (with Ctrl from the other side), 5 switches between
 *  perspective and orthographic, Home or Numpad . frames everything or the
 *  selection. A click selects an object; its properties show on the right, and
 *  editable ones (lengths, angles, numbers, switches, choices) change the document
 *  through the engine.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { dirname, join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { FileChangeType, IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IMarkerData, IMarkerService, MarkerSeverity } from '../../../platform/markers/common/markers.js';
import { CadDocument, CadMeshInfo, CadProperty, CadTessellation, CadTreeItem } from '../../common/cad/cadEngine.js';
import { ITriageCadEngineService } from '../../common/cad/cadEngineService.js';
import { ITriageEdaEngineService } from '../../common/eda/edaEngine.js';
import { Message } from '../../common/eda/protobuf.js';
import { ISimFrame, ITriageSimService, SimState } from '../../common/sim/simService.js';
import { CadRenderer, rotationAbout, SceneObject } from './cadRenderer.js';

/** The board document the CAD engine builds (engines/cad/triage/engine/triage_cad/board.py). */
export const BOARD_DOCUMENT = 'TriageBoard';

/**
 * How long the 3D tab waits for KiCad's engine before showing the documents without
 * the board (an engine that isn't installed keeps reconnecting and never answers).
 */
const EDA_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(localize('triage.cad.edaTimeout', "KiCad's engine didn't answer within {0} s", ms / 1000))), ms);
		promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
	});
}

/** The owner of the fit checks' entries in the Problems panel. */
const FIT_MARKERS = 'triage.fit';

interface FitProblem {
	readonly severity: 'error' | 'warning';
	readonly kind: 'interference' | 'clearance';
	readonly message: string;
	readonly a: { readonly doc: string; readonly object: string; readonly label: string };
	readonly b: { readonly doc: string; readonly object: string; readonly label: string };
	readonly facesA?: readonly number[];
	readonly facesB?: readonly number[];
}

interface LoadedDocument {
	readonly name: string;
	readonly label: string;
	readonly path?: string;
	objects: readonly CadTreeItem[];
	meshes: readonly CadMeshInfo[];
}

/** Board3D (protobuf, KiCad's engine) as the CAD engine's board.update takes it. */
export function boardToJson(board: Message): unknown {
	const points = (list: Message[] | undefined) => (list ?? []).map(p => ({ x: p.x ?? 0, y: p.y ?? 0 }));
	return {
		thickness: board.thickness ?? 1.6,
		outlineOk: board.outlineOk ?? false,
		outlines: (board.outlines ?? []).map((o: Message) => ({
			points: points(o.points),
			cutouts: (o.cutouts ?? []).map((c: Message) => ({ points: points(c.points) })),
		})),
		holes: (board.holes ?? []).map((h: Message) => ({
			x: h.x ?? 0, y: h.y ?? 0, width: h.width ?? 0, height: h.height ?? 0, angle: h.angle ?? 0,
			plated: h.plated ?? false, footprint: h.footprint ?? '', pad: h.pad ?? '',
		})),
		footprints: (board.footprints ?? []).map((f: Message) => ({
			uuid: f.uuid ?? '', reference: f.reference ?? '', value: f.value ?? '', footprint: f.footprint ?? '',
			x: f.x ?? 0, y: f.y ?? 0, angle: f.angle ?? 0, back: f.back ?? false, height: f.height ?? 0,
			boardOnly: f.boardOnly ?? false, courtyard: points(f.courtyard),
		})),
	};
}

export class CadView extends Disposable {
	readonly element: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly outliner: HTMLElement;
	private readonly propertiesPanel: HTMLElement;
	private readonly status: HTMLElement;
	private renderer: CadRenderer | undefined;
	private readonly docDisposables = this._register(new DisposableStore());
	/** The outliner rows' listeners, replaced at each render. */
	private readonly outlinerDisposables = this._register(new DisposableStore());
	/** The properties panel's listeners, replaced at each render. */
	private readonly propertyDisposables = this._register(new DisposableStore());

	private readonly documents = new Map<string, LoadedDocument>();
	private mechanicalPaths: readonly string[] = [];
	private boardPath: string | undefined;
	/** The KiCad engine's document the board was last read from. */
	private boardDocument = 0;
	private selection: string | undefined;
	private frameRequested = false;
	private loadGeneration = 0;
	private boardTimer: ReturnType<typeof setTimeout> | undefined;
	private fitted = false;
	private lastFrameMs = 0;
	/** Why the board isn't shown, if it isn't. */
	private boardError: string | undefined;
	private problems: readonly FitProblem[] = [];

	private readonly _onDidLoad = this._register(new Emitter<void>());
	/** Fires after the documents and the board are drawn (tests wait for it). */
	readonly onDidLoad = this._onDidLoad.event;

	constructor(
		@ITriageCadEngineService private readonly cad: ITriageCadEngineService,
		@ITriageEdaEngineService private readonly eda: ITriageEdaEngineService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ITriageSimService private readonly sim: ITriageSimService,
	) {
		super();
		this._register(toDisposable(() => this.markerService.changeAll(FIT_MARKERS, [])));
		// Simulation playback (ROADMAP P3-4): bodies turn, LEDs glow.
		this._register(this.sim.onDidFrame(frame => this.onSimFrame(frame)));
		this._register(this.sim.onDidChangeState(state => this.onSimState(state)));
		this._register(toDisposable(() => this.disposed = true));
		this.element = $('.triage-cad-view');
		this.element.dataset['state'] = 'empty';
		this.element.tabIndex = 0;
		this.toolbar = append(this.element, $('.triage-cad-toolbar'));
		const body = append(this.element, $('.triage-cad-body'));
		this.stage = append(body, $('.triage-cad-stage'));
		this.canvas = append(this.stage, $('canvas.triage-cad-canvas')) as HTMLCanvasElement;
		const side = append(body, $('.triage-cad-side'));
		append(side, $('.triage-cad-heading', undefined, localize('triage.cad.outliner', "Outliner")));
		this.outliner = append(side, $('.triage-cad-outliner'));
		append(side, $('.triage-cad-heading', undefined, localize('triage.cad.properties', "Properties")));
		this.propertiesPanel = append(side, $('.triage-cad-properties'));
		this.status = append(this.element, $('.triage-cad-status'));
		try {
			this.renderer = new CadRenderer(this.canvas);
		} catch (error) {
			this.setStatus(localize('triage.cad.noWebGL', "This tab needs WebGL2: {0}", String(error)));
		}
		this._register(toDisposable(() => this.renderer?.dispose()));
		this.buildToolbar();
		this.registerInput();
		this._register(this.cad.onDidRestart(() => {
			this.logService.info('[triage] CAD engine restarted, reloading the 3D tab');
			void this.open(this.mechanicalPaths, this.boardPath);
		}));
		this._register(this.eda.onDidChangeDocument(change => {
			if (change.path === this.boardPath) {
				this.boardDocument = change.document;
				this.scheduleBoard();
			}
		}));
		this._register(this.eda.onDidRestart(() => {
			this.boardDocument = 0;
			this.scheduleBoard();
		}));
		this._register(toDisposable(() => clearTimeout(this.boardTimer)));
	}

	/** The objects drawn, by key ("<document>/<object>") (tests use it). */
	get objects(): readonly SceneObject[] {
		return this.renderer?.sceneObjects ?? [];
	}

	get selected(): string | undefined {
		return this.selection;
	}

	// ---- Loading ---------------------------------------------------------------------------

	/** Shows the given FreeCAD documents and the board of `boardPath` (a .kicad_pcb). */
	async open(mechanicalPaths: readonly string[], boardPath: string | undefined): Promise<void> {
		const generation = ++this.loadGeneration;
		this.mechanicalPaths = mechanicalPaths;
		this.boardPath = boardPath;
		this.element.dataset['state'] = 'loading';
		this.docDisposables.clear();
		this.documents.clear();
		this.renderer?.removeObjects('');
		this.setStatus(localize('triage.cad.loading', "Opening the 3D model in FreeCAD's engine…"));
		try {
			for (const path of mechanicalPaths) {
				const { result } = await this.cad.call<CadDocument>('document.open', { path });
				if (generation !== this.loadGeneration) {
					return;
				}
				this.documents.set(result.name, { name: result.name, label: result.label, path, objects: result.objects, meshes: [] });
				await this.tessellate(result.name);
				this.watch(path, result.name);
			}
			if (boardPath) {
				this.watch(boardPath, undefined);
				try {
					await this.loadBoard();
				} catch (error) {
					// The FreeCAD documents still show; the board says why it doesn't.
					this.boardError = error instanceof Error ? error.message : String(error);
					this.logService.warn('[triage] 3D tab: the board did not load', error);
				}
			}
			if (generation !== this.loadGeneration) {
				return;
			}
			if (!this.fitted) {
				this.renderer?.setView('iso');
				this.renderer?.frame();
				this.fitted = true;
			}
			await this.checkFit();
			this.element.dataset['state'] = 'ready';
			this.updateDataset();
			this.renderOutliner();
			this.scheduleRender();
			this.setStatus(this.summary());
			this._onDidLoad.fire();
		} catch (error) {
			this.element.dataset['state'] = 'error';
			this.setStatus(localize('triage.cad.failed', "The 3D model didn't load: {0}", error instanceof Error ? error.message : String(error)));
			this.logService.error('[triage] 3D tab', error);
		}
	}

	private async tessellate(doc: string): Promise<void> {
		const { result, meshes } = await this.cad.call<CadTessellation>('document.tessellate', { doc });
		const loaded = this.documents.get(doc);
		if (loaded) {
			loaded.meshes = result.meshes;
		}
		this.renderer?.removeObjects(`${doc}/`);
		for (const mesh of meshes) {
			const info = result.meshes[mesh.index];
			const key = `${doc}/${info.object}`;
			this.renderer?.setObject({
				key,
				mesh,
				colour: info.colour ? [info.colour[0], info.colour[1], info.colour[2]] : undefined,
				visible: true,
				selected: key === this.selection,
				problem: false,
			});
		}
		this.scheduleRender();
	}

	/** Reads the live board from KiCad's engine and has the CAD engine build it. */
	private async loadBoard(): Promise<void> {
		const path = this.boardPath;
		if (!path) {
			return;
		}
		let document: number = this.boardDocument || this.eda.documentFor(path) || 0;
		if (!document) {
			const opened = await withTimeout(this.eda.call('openDocument', { path }), EDA_TIMEOUT_MS);
			document = opened.response.document.document as number;
		}
		this.boardDocument = document;
		const started = performance.now();
		const reply = await withTimeout(this.eda.call('getBoard3d', { document }), EDA_TIMEOUT_MS);
		const { result } = await this.cad.call<{ doc: string; objects: CadTreeItem[] }>('board.update', { board: boardToJson(reply.response.board3d) });
		this.boardError = undefined;
		this.documents.set(result.doc, { name: result.doc, label: localize('triage.cad.board', "Board"), objects: result.objects, meshes: [] });
		await this.tessellate(result.doc);
		// Enclosures follow the board (ROADMAP P2-4): its outline, holes and connectors.
		for (const doc of [...this.documents.values()]) {
			if (doc.objects.some(item => item.proxy === 'Enclosure')) {
				const updated = await this.cad.call<{ changed: boolean; objects: CadTreeItem[] }>('enclosure.fromBoard', { doc: doc.name });
				doc.objects = updated.result.objects;
				if (updated.result.changed) {
					await this.tessellate(doc.name);
				}
			}
		}
		this.logService.trace(`[triage] 3D board rebuilt in ${(performance.now() - started).toFixed(0)} ms`);
	}

	/**
	 * Fit and clearance between the board, its parts and the mechanical documents
	 * (ROADMAP P2-5): colliding objects turn red, and every problem goes to the
	 * Problems panel, under the board's file (or the document's). Returns the count.
	 */
	async checkFit(): Promise<number> {
		const docs = [...this.documents.keys()];
		for (const object of this.objects) {
			object.problem = false;
			object.highlightFaces = undefined;
		}
		this.problems = [];
		if (docs.length >= 2) {
			const { result } = await this.cad.call<{ problems: FitProblem[]; milliseconds: number }>('checks.fit', { docs });
			this.problems = result.problems;
			for (const problem of result.problems) {
				if (problem.severity !== 'error') {
					continue;
				}
				for (const [side, faces] of [[problem.a, problem.facesA], [problem.b, problem.facesB]] as const) {
					const object = this.renderer?.getObject(`${side.doc}/${side.object}`);
					if (object) {
						object.problem = true;
						object.highlightFaces = new Set(faces ?? []);
					}
				}
			}
		}
		const markers = new Map<string, IMarkerData[]>();
		for (const problem of this.problems) {
			const file = this.fileFor(problem.a.doc) ?? this.fileFor(problem.b.doc);
			if (!file) {
				continue;
			}
			const list = markers.get(file) ?? [];
			list.push({
				severity: problem.severity === 'error' ? MarkerSeverity.Error : MarkerSeverity.Warning,
				message: problem.message,
				source: localize('triage.cad.fitSource', "Triage fit check"),
				code: problem.kind,
				startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1,
			});
			markers.set(file, list);
		}
		this.markerService.changeAll(FIT_MARKERS, [...markers].flatMap(([file, list]) => list.map(marker => ({ resource: URI.file(file), marker }))));
		this.renderOutliner();
		this.scheduleRender();
		return this.problems.length;
	}

	/** The file a document's problems belong to: the board's for the board, else its own. */
	private fileFor(doc: string): string | undefined {
		return doc === BOARD_DOCUMENT ? this.boardPath : this.documents.get(doc)?.path;
	}

	/** Gives a part a "Height" field in the live board (an engine edit, undoable there). */
	async setPartHeight(reference: string, height: number): Promise<void> {
		if (!this.boardPath || !(height >= 0)) {
			throw new Error(localize('triage.cad.badHeight', "The 3D tab needs a board and a height of 0 mm or more."));
		}
		const document = this.boardDocument || this.eda.documentFor(this.boardPath);
		if (!document) {
			throw new Error(localize('triage.cad.noBoardOpen', "The board isn't open in KiCad's engine yet."));
		}
		const items = await this.eda.call('getItems', { document, references: [reference] });
		const uuid = items.response.items?.items?.[0]?.uuid as string | undefined;
		if (!uuid) {
			throw new Error(localize('triage.cad.noPart', "The board has no part {0}.", reference));
		}
		await this.eda.call('edit', { document, setField: { uuid, field: 'Height', text: `${height} mm` } });
	}

	/** Writes the enclosure's parts as STL files beside its document (mechanical/exports/). */
	async exportEnclosure(): Promise<string[]> {
		const doc = [...this.documents.values()].find(d => d.path && d.objects.some(item => item.proxy === 'Enclosure'));
		if (!doc?.path) {
			throw new Error(localize('triage.cad.noEnclosure', "The project has no enclosure document."));
		}
		const folder = join(dirname(doc.path), 'exports');
		const { result } = await this.cad.call<{ files: { path: string; valid: boolean; closed: boolean }[] }>('enclosure.export', { doc: doc.name, folder });
		this.setStatus(localize('triage.cad.exported', "Wrote {0} for printing", result.files.map(f => f.path).join(', ')));
		return result.files.map(f => f.path);
	}

	/** A board edit or save: rebuild the board soon (edits come in bursts while dragging). */
	private scheduleBoard(): void {
		if (!this.boardPath || this.element.dataset['state'] !== 'ready') {
			return;
		}
		clearTimeout(this.boardTimer);
		this.boardTimer = setTimeout(() => {
			void this.loadBoard().then(() => this.checkFit()).then(() => {
				this.updateDataset();
				this.renderOutliner();
				this.setStatus(this.summary());
				this._onDidLoad.fire();
			}, error => this.setStatus(localize('triage.cad.boardFailed', "The board didn't update: {0}", String(error))));
		}, 120);
	}

	/** Reloads a document saved by another program (stock FreeCAD or KiCad). */
	private watch(path: string, doc: string | undefined): void {
		const uri = URI.file(path);
		this.docDisposables.add(this.fileService.watch(uri));
		this.docDisposables.add(this.fileService.onDidFilesChange(event => {
			if (!event.contains(uri, FileChangeType.UPDATED)) {
				return;
			}
			if (doc) {
				void this.cad.call('document.close', { doc }).then(() => this.open(this.mechanicalPaths, this.boardPath));
			} else {
				this.scheduleBoard();
			}
		}));
	}

	/** What tests read: how many objects are drawn, and whether the board is. */
	private updateDataset(): void {
		this.element.dataset['objects'] = String(this.objects.length);
		this.element.dataset['hidden'] = this.objects.filter(o => !o.visible).map(o => o.key).join(' ');
		this.element.dataset['problems'] = String(this.problems.filter(p => p.severity === 'error').length);
		this.element.dataset['problemObjects'] = this.objects.filter(o => o.problem).map(o => o.key).join(' ');
		this.element.dataset['board'] = !this.boardPath ? 'none' : this.boardError ? 'error' : 'shown';
		this.element.dataset['boardUpdates'] = String((Number(this.element.dataset['boardUpdates']) || 0) + 1);
	}

	private summary(): string {
		if (this.boardError) {
			return localize('triage.cad.noBoard', "The board isn't shown: {0}", this.boardError);
		}
		let triangles = 0;
		for (const doc of this.documents.values()) {
			for (const mesh of doc.meshes) {
				triangles += mesh.triangles;
			}
		}
		const errors = this.problems.filter(p => p.severity === 'error').length;
		const fits = errors > 0
			? localize('triage.cad.fitProblems', "{0} fit problem(s): see the Problems panel", errors)
			: localize('triage.cad.fitOk', "everything fits");
		return localize('triage.cad.summary', "{0} objects, {1} triangles · {2} · {3} ms per frame", this.objects.length, triangles, fits, this.lastFrameMs.toFixed(1));
	}

	// ---- Drawing ---------------------------------------------------------------------------

	layout(width: number, height: number): void {
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		// In a narrow tab the outliner and properties would leave the model no room.
		this.element.classList.toggle('narrow', width < 640);
		this.scheduleRender();
	}

	// ---- Simulation playback (ROADMAP P3-4) ----------------------------------------------

	private simFrame: { frame: ISimFrame; at: number } | undefined;
	private simAnimating = false;
	private disposed = false;

	/** The drawn objects of a simulated body's 3D object ("fan.FCStd#Rotor"). */
	private keysFor(object: string): string[] {
		const [file, name] = object.split('#');
		const doc = [...this.documents.values()].find(d => d.path !== undefined && (d.path.endsWith(`/${file}`) || d.path.endsWith(`\\${file}`) || d.path === file));
		if (!doc) {
			return [];
		}
		const exact = `${doc.name}/${name}`;
		const keys = this.objects.map(o => o.key);
		return keys.includes(exact) ? [exact] : keys.filter(key => key.startsWith(`${doc.name}/`));
	}

	private onSimState(state: SimState): void {
		if (state.kind === 'idle' || state.kind === 'error') {
			this.simFrame = undefined;
			for (const object of this.objects) {
				object.model = undefined;
				object.emissive = undefined;
			}
			this.element.dataset['simAngle'] = '';
			this.scheduleRender();
		}
	}

	private onSimFrame(frame: ISimFrame): void {
		this.simFrame = { frame, at: performance.now() };
		this.applySim();
		this.scheduleRender();
		if (frame.running && !this.simAnimating) {
			this.simAnimating = true;
			this.animateSim();
		}
	}

	/** Draws at the display's rate while a run is going, turning bodies between frames by their speed. */
	private animateSim(): void {
		getWindow(this.element).requestAnimationFrame(() => {
			if (!this.simFrame?.frame.running || this.disposed) {
				this.simAnimating = false;
				return;
			}
			this.applySim();
			if (this.renderer) {
				this.lastFrameMs = this.renderer.render();
			}
			this.animateSim();
		});
	}

	private applySim(): void {
		const state = this.sim.state;
		const current = this.simFrame;
		if (!current || !('info' in state)) {
			return;
		}
		const { frame, at } = current;
		// Ahead of the last frame by the time since, at the run's speed (at most 0.1 s).
		const ahead = frame.running ? Math.min((performance.now() - at) / 1000 * frame.ratio, 0.1) : 0;
		const angles: string[] = [];
		for (const body of state.info.bodies) {
			if (!body.object) {
				continue;
			}
			const angle = (frame.values[body.angle] ?? 0) + (frame.values[body.omega] ?? 0) * ahead;
			const origin = body.origin.map(v => v * 1000);
			const model = rotationAbout(body.axis, origin, angle);
			for (const key of this.keysFor(body.object)) {
				const object = this.renderer?.getObject(key);
				if (object) {
					object.model = model;
				}
			}
			angles.push(`${body.name}=${angle.toFixed(3)}`);
		}
		for (const [reference, signal] of state.info.leds) {
			const object = this.renderer?.getObject(`${BOARD_DOCUMENT}/Part_${reference.replace(/[^A-Za-z0-9_]/g, '_')}`);
			const brightness = Math.max(0, Math.min(1, frame.values[signal] ?? 0));
			if (object) {
				object.emissive = brightness > 0.01 ? [0.9 * brightness, 0.1 * brightness, 0.05 * brightness] : undefined;
			}
		}
		this.element.dataset['simAngle'] = angles.join(' ');
		this.element.dataset['simT'] = frame.t.toFixed(3);
	}

	private scheduleRender(): void {
		if (this.frameRequested || !this.renderer) {
			return;
		}
		this.frameRequested = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.frameRequested = false;
			if (this.renderer) {
				this.lastFrameMs = this.renderer.render();
			}
		});
	}

	/** Draws `frames` frames back to back and returns their frame rate (the benchmark command). */
	async benchmark(frames = 120): Promise<{ fps: number; cpuMs: number }> {
		const renderer = this.renderer;
		if (!renderer) {
			return { fps: 0, cpuMs: 0 };
		}
		const window = getWindow(this.element);
		let cpu = 0;
		const started = performance.now();
		for (let i = 0; i < frames; i++) {
			renderer.orbit(3, 0);
			cpu += renderer.render();
			await new Promise(resolve => window.requestAnimationFrame(resolve));
		}
		const seconds = (performance.now() - started) / 1000;
		return { fps: frames / seconds, cpuMs: cpu / frames };
	}

	// ---- Input -----------------------------------------------------------------------------

	private registerInput(): void {
		let drag: { x: number; y: number; mode: 'orbit' | 'pan' | 'zoom' | 'select'; moved: boolean } | undefined;
		this._register(addDisposableListener(this.canvas, EventType.POINTER_DOWN, (event: PointerEvent) => {
			this.element.focus();
			const middle = event.button === 1;
			const altLeft = event.button === 0 && event.altKey;
			let mode: 'orbit' | 'pan' | 'zoom' | 'select' = 'select';
			if (middle || altLeft) {
				mode = event.shiftKey ? 'pan' : event.ctrlKey ? 'zoom' : 'orbit';
			} else if (event.button === 2) {
				mode = 'pan';
			}
			drag = { x: event.clientX, y: event.clientY, mode, moved: false };
			this.canvas.setPointerCapture(event.pointerId);
			event.preventDefault();
		}));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!drag || !this.renderer) {
				return;
			}
			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 2) {
				drag.moved = true;
			}
			drag.x = event.clientX;
			drag.y = event.clientY;
			if (drag.mode === 'orbit') {
				this.renderer.orbit(dx, dy);
			} else if (drag.mode === 'pan') {
				this.renderer.pan(dx, dy);
			} else if (drag.mode === 'zoom') {
				this.renderer.zoom(Math.pow(1.01, dy));
			}
			this.scheduleRender();
		}));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_UP, (event: PointerEvent) => {
			const finished = drag;
			drag = undefined;
			if (finished?.mode === 'select' && !finished.moved && this.renderer) {
				const rect = this.canvas.getBoundingClientRect();
				const hit = this.renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
				this.select(hit?.key, event.shiftKey);
			}
		}));
		this._register(addDisposableListener(this.canvas, EventType.CONTEXT_MENU, event => event.preventDefault()));
		this._register(addDisposableListener(this.canvas, EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			event.preventDefault();
			this.renderer?.zoom(Math.pow(1.0015, event.deltaY));
			this.scheduleRender();
		}, { passive: false }));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (this.handleKey(event)) {
				event.preventDefault();
				event.stopPropagation();
			}
		}));
	}

	private handleKey(event: KeyboardEvent): boolean {
		const renderer = this.renderer;
		if (!renderer || (event.target as HTMLElement | null)?.tagName === 'INPUT') {
			return false;
		}
		const other = event.ctrlKey;
		switch (event.code) {
			case 'Numpad1': renderer.setView(other ? 'back' : 'front'); break;
			case 'Numpad3': renderer.setView(other ? 'left' : 'right'); break;
			case 'Numpad7': renderer.setView(other ? 'bottom' : 'top'); break;
			case 'Numpad5': renderer.camera.perspective = !renderer.camera.perspective; break;
			case 'Numpad4': renderer.orbit(-37.5, 0); break;
			case 'Numpad6': renderer.orbit(37.5, 0); break;
			case 'Numpad8': renderer.orbit(0, 37.5); break;
			case 'Numpad2': renderer.orbit(0, -37.5); break;
			case 'NumpadDecimal': renderer.frame(this.selection ? renderer.bounds([this.selection]) : undefined); break;
			case 'Home': renderer.frame(); break;
			case 'Escape': this.select(undefined, false); return true;
			case 'KeyN': this.togglePanel(); break;
			// Blender: H hides the selection, Alt+H shows everything, Shift+H isolates it.
			case 'KeyH':
				if (event.altKey) {
					this.setVisible(() => true);
				} else if (event.shiftKey && this.selection) {
					const keep = this.selection;
					this.setVisible(object => object.key === keep);
				} else if (this.selection) {
					const hide = this.selection;
					this.setVisible(object => object.visible && object.key !== hide);
				}
				break;
			default: return false;
		}
		this.scheduleRender();
		return true;
	}

	private buildToolbar(): void {
		append(this.toolbar, $('span.triage-cad-title', undefined, localize('triage.cad.title', "3D")));
		const button = (label: string, title: string, run: () => void) => {
			const element = append(this.toolbar, $('button.triage-cad-button', { title }, label));
			this._register(addDisposableListener(element, EventType.CLICK, () => {
				run();
				this.scheduleRender();
			}));
		};
		button(localize('triage.cad.front', "Front"), localize('triage.cad.frontTitle', "Look from the front (Numpad 1)"), () => this.renderer?.setView('front'));
		button(localize('triage.cad.right', "Right"), localize('triage.cad.rightTitle', "Look from the right (Numpad 3)"), () => this.renderer?.setView('right'));
		button(localize('triage.cad.top', "Top"), localize('triage.cad.topTitle', "Look from the top (Numpad 7)"), () => this.renderer?.setView('top'));
		button(localize('triage.cad.iso', "Iso"), localize('triage.cad.isoTitle', "Look from above at an angle"), () => this.renderer?.setView('iso'));
		button(localize('triage.cad.frameAll', "Frame All"), localize('triage.cad.frameAllTitle', "Show everything (Home)"), () => this.renderer?.frame());
		button(localize('triage.cad.exportStl', "Export STL"), localize('triage.cad.exportStlTitle', "Write the enclosure's base and lid as STL files for printing (mechanical/exports/)"), () => {
			void this.exportEnclosure().catch(error => this.setStatus(error instanceof Error ? error.message : String(error)));
		});
		button(localize('triage.cad.panel', "Panel"), localize('triage.cad.panelTitle', "Show or hide the outliner and properties (N)"), () => this.togglePanel());
		button(localize('triage.cad.projection', "Persp/Ortho"), localize('triage.cad.projectionTitle', "Switch between perspective and orthographic (Numpad 5)"), () => {
			if (this.renderer) {
				this.renderer.camera.perspective = !this.renderer.camera.perspective;
			}
		});
	}

	// ---- Selection, outliner and properties -----------------------------------------------------

	/** Shows the objects `visible` says yes to and hides the others. */
	setVisible(visible: (object: SceneObject) => boolean): void {
		for (const object of this.objects) {
			object.visible = visible(object);
		}
		this.renderOutliner();
		this.updateDataset();
		this.scheduleRender();
	}

	/** Blender's N panel: shows or hides the outliner and properties. */
	private togglePanel(): void {
		const shown = this.element.classList.contains('narrow')
			? !this.element.classList.contains('panel-open')
			: this.element.classList.contains('panel-closed');
		this.element.classList.toggle('panel-open', shown);
		this.element.classList.toggle('panel-closed', !shown);
		this.scheduleRender();
	}

	select(key: string | undefined, _add: boolean): void {
		this.selection = key;
		for (const object of this.objects) {
			object.selected = object.key === key;
		}
		this.renderOutliner();
		void this.renderProperties();
		this.scheduleRender();
	}

	private renderOutliner(): void {
		clearNode(this.outliner);
		this.outlinerDisposables.clear();
		for (const doc of this.documents.values()) {
			const row = append(this.outliner, $('.triage-cad-doc'));
			row.title = doc.path ?? doc.label;
			const docObjects = this.objects.filter(o => o.key.startsWith(`${doc.name}/`));
			this.eye(row, docObjects.some(o => o.visible), () => {
				const show = !docObjects.some(o => o.visible);
				this.setVisible(o => o.key.startsWith(`${doc.name}/`) ? show : o.visible);
			});
			append(row, $('span', undefined, doc.label));
			const shown = new Set(doc.meshes.map(m => m.object));
			for (const item of doc.objects) {
				if (!shown.has(item.name) && item.parent === null && !item.children.length) {
					continue;
				}
				if (item.parent !== null && !shown.has(item.name)) {
					continue;
				}
				const key = `${doc.name}/${item.name}`;
				const entry = append(this.outliner, $('.triage-cad-item'));
				const drawn = this.renderer?.getObject(key);
				if (drawn) {
					this.eye(entry, drawn.visible, () => this.setVisible(o => o.key === key ? !o.visible : o.visible));
				}
				append(entry, $('span', undefined, item.label));
				entry.dataset['key'] = key;
				entry.title = `${item.label} (${item.type})`;
				entry.classList.toggle('selected', key === this.selection);
				entry.classList.toggle('invalid', item.state.includes('Invalid'));
				entry.classList.toggle('problem', this.renderer?.getObject(key)?.problem === true);
				this.outlinerDisposables.add(addDisposableListener(entry, EventType.CLICK, () => this.select(key, false)));
			}
		}
	}

	/** An eye toggle at the start of an outliner row. */
	private eye(row: HTMLElement, visible: boolean, toggle: () => void): void {
		const icon = append(row, $(`span.triage-cad-eye.codicon.codicon-${visible ? 'eye' : 'eye-closed'}`));
		icon.title = visible ? localize('triage.cad.hide', "Hide (H)") : localize('triage.cad.show', "Show (Alt+H shows everything)");
		this.outlinerDisposables.add(addDisposableListener(icon, EventType.CLICK, event => {
			event.stopPropagation();
			toggle();
		}));
	}

	private async renderProperties(): Promise<void> {
		clearNode(this.propertiesPanel);
		this.propertyDisposables.clear();
		const key = this.selection;
		if (!key) {
			append(this.propertiesPanel, $('.triage-cad-hint', undefined, localize('triage.cad.selectHint', "Select an object to see its properties.")));
			return;
		}
		const [doc, object] = key.split('/');
		const { result } = await this.cad.call<{ label: string; type: string; properties: CadProperty[] }>('object.properties', { doc, object });
		if (this.selection !== key) {
			return;
		}
		// Another render may have started while this one waited for the engine.
		clearNode(this.propertiesPanel);
		this.propertyDisposables.clear();
		append(this.propertiesPanel, $('.triage-cad-object', undefined, `${result.label} · ${result.type}`));
		const editable = doc !== BOARD_DOCUMENT;
		for (const property of result.properties) {
			if (property.hidden || property.value === null || property.value === undefined) {
				continue;
			}
			const row = append(this.propertiesPanel, $('.triage-cad-property'));
			row.title = property.doc;
			append(row, $('span.triage-cad-name', undefined, property.name));
			append(row, this.propertyEditor(doc, object, property, editable && !property.readOnly));
		}
	}

	private propertyEditor(doc: string, object: string, property: CadProperty, editable: boolean): HTMLElement {
		const value = property.value as unknown;
		const set = (next: unknown) => void this.setProperty(doc, object, property.name, next);
		if (typeof value === 'boolean') {
			const box = $('input', { type: 'checkbox' }) as HTMLInputElement;
			box.checked = value;
			box.disabled = !editable;
			this.propertyDisposables.add(addDisposableListener(box, EventType.CHANGE, () => set(box.checked)));
			return box;
		}
		if (typeof value === 'object' && value !== null && 'options' in value) {
			const choice = value as { value: string; options: string[] };
			const select = $('select') as HTMLSelectElement;
			for (const option of choice.options) {
				const element = append(select, $('option', undefined, option)) as HTMLOptionElement;
				element.selected = option === choice.value;
			}
			select.disabled = !editable;
			this.propertyDisposables.add(addDisposableListener(select, EventType.CHANGE, () => set(select.value)));
			return select;
		}
		const isQuantity = typeof value === 'object' && value !== null && 'text' in value;
		if (typeof value === 'number' || isQuantity || typeof value === 'string') {
			const input = $('input', { type: 'text' }) as HTMLInputElement;
			input.value = isQuantity ? (value as { text: string }).text : String(value);
			input.readOnly = !editable;
			input.dataset['property'] = property.name;
			// Enter or leaving the field sends the edit, once per new text.
			let sent = input.value;
			const commit = () => {
				if (editable && input.value !== sent) {
					sent = input.value;
					set(typeof value === 'number' ? Number(input.value) : input.value);
				}
			};
			this.propertyDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter') {
					commit();
				}
			}));
			this.propertyDisposables.add(addDisposableListener(input, EventType.BLUR, commit));
			return input;
		}
		return $('span.triage-cad-value', undefined, JSON.stringify(value));
	}

	/** One property edit: an engine transaction, then the document's meshes again. */
	async setProperty(doc: string, object: string, property: string, value: unknown): Promise<void> {
		try {
			const started = performance.now();
			const { result } = await this.cad.call<{ objects: CadTreeItem[] }>('object.setProperty', { doc, object, property, value });
			const loaded = this.documents.get(doc);
			if (loaded) {
				loaded.objects = result.objects;
			}
			await this.tessellate(doc);
			await this.checkFit();
			this.element.dataset['edits'] = String((Number(this.element.dataset['edits']) || 0) + 1);
			this.updateDataset();
			this.setStatus(localize('triage.cad.edited', "{0}.{1} changed; recomputed and redrawn in {2} ms", object, property, (performance.now() - started).toFixed(0)));
			this.renderOutliner();
			void this.renderProperties();
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : String(error));
		}
	}

	private setStatus(text: string): void {
		this.status.textContent = text;
	}
}
