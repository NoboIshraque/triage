/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Schematic and Board tabs (ROADMAP P1-4, P1-6): one KiCad document drawn by
 *  KiCad's own painters through the Stream GAL, on Triage's WebGL2 canvas.
 *
 *  Mouse: wheel zooms at the cursor, middle or right drag pans, a click selects
 *  (through KiCad's hit testing), dragging a selection moves it. Keys: R rotates,
 *  Delete deletes, E edits the value, F2 the reference, W draws a wire (schematic)
 *  or a track (board) until Escape, Ctrl+Z / Ctrl+Y undo and redo, Ctrl+S saves,
 *  Home fits the document. Every edit is an engine commit (ROADMAP P1-6).
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, toAction } from '../../../base/common/actions.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { EDA_COMMANDS } from './edaCommandIds.js';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { FileChangeType, IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { DisplayListModel } from '../../common/eda/displayList.js';
import { ITriageCrossProbeService, ProbeSource } from '../../common/eda/crossProbe.js';
import { DocumentKind } from '../../common/eda/engineApi.generated.js';
import { EdaEngineError, IEdaResult, ITriageEdaEngineService } from '../../common/eda/edaEngine.js';
import { Message } from '../../common/eda/protobuf.js';
import { Camera, EdaRenderer } from './edaRenderer.js';

export type EdaViewKind = 'schematic' | 'board';

interface LayerInfo {
	readonly id: number;
	readonly name: string;
	readonly color: number;
	readonly order: number;
	readonly user: boolean;
	readonly required: number;
	visible: boolean;
}

/** Grid for snapping moves and new wires: 50 mil on schematics, 0.25 mm on boards. */
const GRID = { schematic: 12700, board: 250_000 } as const;
const DRAG_PIXELS = 4;

export class EdaDocumentView extends Disposable {
	readonly element: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly overlay: HTMLCanvasElement;
	private readonly status: HTMLElement;
	private readonly layerPanel: HTMLElement;
	private renderer: EdaRenderer | undefined;
	private readonly model = new DisplayListModel();
	private readonly docDisposables = this._register(new DisposableStore());

	private path: string | undefined;
	private document = 0;
	private info: Message | undefined;
	private sheet = '';
	private layers = new Map<number, LayerInfo>();
	private camera: Camera = { cx: 0, cy: 0, scale: 1e-5 };
	private width = 0;
	private height = 0;
	private frameRequested = false;
	private selection: Message[] = [];
	private wire: number[] | undefined;
	private cursorWorld: [number, number] = [0, 0];
	/** True while the engine writes our own save. */
	private saving = false;
	/** The file as our last save left it: a change event that still matches it is our own write. */
	private ownSave: { mtime: number; size: number } | undefined;
	private loadGeneration = 0;
	private lastFrameMs = 0;
	/** Whether the camera was fitted to the document since it opened. */
	private fitted = false;

	private readonly _onDidSelect = this._register(new Emitter<readonly Message[]>());
	readonly onDidSelect = this._onDidSelect.event;

	constructor(
		readonly kind: EdaViewKind,
		@ITriageEdaEngineService private readonly engine: ITriageEdaEngineService,
		@ITriageCrossProbeService private readonly crossProbe: ITriageCrossProbeService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.triage-eda-view');
		this.element.dataset['triageEda'] = kind;
		this.element.dataset['state'] = 'empty';
		this.element.tabIndex = 0;
		this.toolbar = append(this.element, $('.triage-eda-toolbar'));
		this.stage = append(this.element, $('.triage-eda-stage'));
		this.canvas = append(this.stage, $('canvas.triage-eda-canvas')) as HTMLCanvasElement;
		this.overlay = append(this.stage, $('canvas.triage-eda-overlay')) as HTMLCanvasElement;
		this.layerPanel = append(this.stage, $('.triage-eda-layers'));
		this.status = append(this.element, $('.triage-eda-status'));
		try {
			this.renderer = new EdaRenderer(this.canvas);
		} catch (error) {
			this.showError(localize('triage.eda.noWebGL', "This tab needs WebGL2: {0}", String(error)));
		}
		this._register(toDisposable(() => this.renderer?.dispose()));
		this.registerInput();
		this._register(this.engine.onDidRestart(() => {
			if (this.path) {
				this.logService.info(`[triage] EDA engine restarted, reopening ${this.path}`);
				void this.open(this.path);
			}
		}));
		this._register(this.crossProbe.onDidProbe(probe => {
			if (probe.source !== this.kind && probe.references.length > 0) {
				void this.selectReferences(probe.references, probe.net);
			}
		}));
	}

	get documentId(): number {
		return this.document;
	}

	get documentPath(): string | undefined {
		return this.path;
	}

	// ---- Loading ---------------------------------------------------------------------------

	async open(path: string): Promise<void> {
		const generation = ++this.loadGeneration;
		this.path = path;
		this.element.dataset['state'] = 'loading';
		this.setStatus(localize('triage.eda.loading', "Loading {0} in KiCad's engine…", basename(path)));
		this.docDisposables.clear();
		try {
			if (this.document) {
				const old = this.document;
				this.document = 0;
				await this.engine.call('closeDocument', { document: old }).catch(() => undefined);
			}
			const opened = await this.engine.call('openDocument', { path });
			if (generation !== this.loadGeneration) {
				return;
			}
			this.document = opened.response.document.document;
			this.setInfo(opened.response.document);
			await this.loadDisplayList(this.sheet);
			if (generation !== this.loadGeneration) {
				return;
			}
			this.fitted = false;
			this.fit();
			this.watch(path);
			if (this.renderer) {
				this.element.dataset['state'] = 'ready';
			}
		} catch (error) {
			if (generation === this.loadGeneration) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private async loadDisplayList(sheet: string): Promise<void> {
		const started = performance.now();
		const result = await this.engine.call('getDisplayList', { document: this.document, sheet });
		if (result.response.documentInfo) {
			this.setInfo(result.response.documentInfo);
		}
		this.model.clear();
		this.renderer?.clear();
		const layers = new Set<number>();
		for (const chunk of result.chunks) {
			for (const layer of this.model.apply(chunk).layers) {
				layers.add(layer);
			}
		}
		this.renderer?.updateLayers(this.model, layers);
		const stats = this.model.stats();
		const ms = performance.now() - started;
		this.element.dataset['groups'] = String(stats.groups);
		this.element.dataset['loadMs'] = ms.toFixed(0);
		this.setStatus(localize('triage.eda.loaded', "{0}: {1} groups ({2} segments, {3} circles, {4} arcs, {5} triangles) in {6} ms",
			basename(this.path ?? ''), stats.groups, stats.segments, stats.circles, stats.arcs, Math.round(stats.triangles), ms.toFixed(0)));
		this.requestFrame();
	}

	/** Applies an update (selection, edit, undo) the engine sent with a response. */
	private applyChunks(result: IEdaResult): void {
		const layers = new Set<number>();
		for (const chunk of result.chunks) {
			for (const layer of this.model.apply(chunk).layers) {
				layers.add(layer);
			}
		}
		this.renderer?.updateLayers(this.model, layers);
		this.element.dataset['groups'] = String(this.model.groups.size);
		this.requestFrame();
	}

	private setInfo(info: Message): void {
		this.info = info;
		this.renderer?.setBackground(info.background);
		if (this.renderer) {
			this.renderer.pixelsPerIuAtScale1 = info.pixelsPerIuAtScale1 || 1;
		}
		const old = this.layers;
		this.layers = new Map();
		for (const layer of info.layers as Message[]) {
			const previous = old.get(layer.id);
			this.layers.set(layer.id, {
				id: layer.id, name: layer.name, color: layer.color, order: layer.order,
				user: layer.user, required: layer.required, visible: previous?.visible ?? layer.visible,
			});
		}
		this.applyLayerVisibility();
		this.renderToolbar();
		this.renderLayerPanel();
	}

	/** A layer shows when it and the user layer it belongs to are on. */
	private applyLayerVisibility(): void {
		const styles = [...this.layers.values()].map(layer => {
			const base = this.layers.get(layer.required);
			return { id: layer.id, order: layer.order, visible: layer.visible && (base === undefined || base === layer || base.visible) };
		});
		this.renderer?.setLayers(styles);
		this.requestFrame();
	}

	private renderToolbar(): void {
		clearNode(this.toolbar);
		const info = this.info;
		if (!info) {
			return;
		}
		append(this.toolbar, $('span.triage-eda-title', undefined, basename(info.path)));
		if (info.kind === DocumentKind.DOCUMENT_KIND_SCHEMATIC && info.sheets.length > 1) {
			const select = append(this.toolbar, $('select.triage-eda-sheets')) as HTMLSelectElement;
			select.setAttribute('aria-label', localize('triage.eda.sheet', "Sheet"));
			for (const sheet of info.sheets as Message[]) {
				const option = append(select, $('option')) as HTMLOptionElement;
				option.value = sheet.path;
				option.text = `${sheet.page ? sheet.page + ' · ' : ''}${sheet.name}`;
			}
			select.value = this.sheet || (info.sheets[0] as Message).path;
			this.docDisposables.add(addDisposableListener(select, EventType.CHANGE, () => {
				this.sheet = select.value;
				void this.loadDisplayList(this.sheet).then(() => this.fit(), error => this.reportError(error));
			}));
		}
		const actions: [string, () => void, string][] = [
			[localize('triage.eda.fit', "Fit"), () => this.fit(), 'fit'],
			[localize('triage.eda.undo', "Undo"), () => void this.undoRedo('undo'), 'undo'],
			[localize('triage.eda.redo', "Redo"), () => void this.undoRedo('redo'), 'redo'],
			[localize('triage.eda.save', "Save"), () => void this.save(), 'save'],
		];
		if (info.kind === DocumentKind.DOCUMENT_KIND_BOARD) {
			actions.push([localize('triage.eda.layersButton', "Layers"), () => this.layerPanel.classList.toggle('open'), 'layers']);
		} else {
			// ROADMAP PA-1: also on a net's right-click menu.
			actions.push([localize('triage.eda.renameNetButton', "Rename Net…"), () => void this.commandService.executeCommand(EDA_COMMANDS.renameNet, this.selectedNet()), 'rename-net']);
		}
		actions.push([localize('triage.eda.kicadButton', "Edit in KiCad"), () => void this.commandService.executeCommand(EDA_COMMANDS.openInKicad), 'kicad']);
		for (const [label, run, action] of actions) {
			const button = append(this.toolbar, $('button.triage-eda-button', undefined, label));
			button.dataset['action'] = action;
			this.docDisposables.add(addDisposableListener(button, EventType.CLICK, run));
		}
		if (info.modified) {
			append(this.toolbar, $('span.triage-eda-modified', undefined, localize('triage.eda.modified', "modified")));
		}
	}

	private renderLayerPanel(): void {
		clearNode(this.layerPanel);
		const user = [...this.layers.values()].filter(layer => layer.user).sort((a, b) => a.id - b.id);
		for (const layer of user) {
			const row = append(this.layerPanel, $('label.triage-eda-layer'));
			const box = append(row, $('input')) as HTMLInputElement;
			box.type = 'checkbox';
			box.checked = layer.visible;
			const swatch = append(row, $('span.triage-eda-swatch'));
			swatch.style.background = cssColor(layer.color);
			append(row, $('span', undefined, layer.name));
			this.docDisposables.add(addDisposableListener(box, EventType.CHANGE, () => {
				layer.visible = box.checked;
				this.applyLayerVisibility();
			}));
		}
	}

	private watch(path: string): void {
		const resource = URI.file(path);
		this.docDisposables.add(this.fileService.watch(resource));
		this.docDisposables.add(this.fileService.onDidFilesChange(event => {
			if (!event.contains(resource, FileChangeType.UPDATED, FileChangeType.ADDED)) {
				return;
			}
			if (this.saving) {
				return; // our own save, still being written
			}
			void this.fileService.stat(resource).then(stat => {
				if (this.ownSave && stat.mtime === this.ownSave.mtime && stat.size === this.ownSave.size) {
					return; // our own save, reported late
				}
				// Saved elsewhere (stock KiCad, ROADMAP P1-7): reload, keeping the view.
				this.logService.info(`[triage] ${path} changed on disk, reloading`);
				return this.reload();
			}).catch(error => this.reportError(error));
		}));
	}

	async reload(): Promise<void> {
		if (!this.document) {
			return;
		}
		const camera = { ...this.camera };
		const reloaded = await this.engine.call('reload', { document: this.document });
		this.setInfo(reloaded.response.document);
		await this.loadDisplayList(this.sheet);
		this.camera = camera;
		this.requestFrame();
		this.element.dataset['reloads'] = String(Number(this.element.dataset['reloads'] ?? '0') + 1);
	}

	// ---- Camera and drawing ----------------------------------------------------------------

	layout(width: number, height: number): void {
		const toolbar = this.toolbar.offsetHeight || 0;
		const status = this.status.offsetHeight || 0;
		this.width = Math.max(1, width);
		this.height = Math.max(1, height - toolbar - status);
		this.stage.style.height = `${this.height}px`;
		for (const canvas of [this.canvas, this.overlay]) {
			canvas.style.width = `${this.width}px`;
			canvas.style.height = `${this.height}px`;
		}
		// The document may have loaded before the tab had a size.
		if (!this.fitted && this.info) {
			this.fit();
		}
		this.requestFrame();
	}

	fit(): void {
		const box = (this.info?.content ?? this.info?.bbox) as Message | undefined;
		if (!box || box.x1 <= box.x0 || this.width <= 1) {
			return;
		}
		const margin = 1.05;
		this.fitted = true;
		this.camera = {
			cx: (box.x0 + box.x1) / 2,
			cy: (box.y0 + box.y1) / 2,
			scale: Math.min(this.width / ((box.x1 - box.x0) * margin), this.height / ((box.y1 - box.y0) * margin)),
		};
		this.requestFrame();
	}

	private requestFrame(): void {
		if (this.frameRequested) {
			return;
		}
		this.frameRequested = true;
		getWindow(this.element).requestAnimationFrame(() => {
			this.frameRequested = false;
			this.drawFrame();
		});
	}

	private drawFrame(): void {
		if (!this.renderer || this.width <= 1) {
			return;
		}
		const ratio = getWindow(this.element).devicePixelRatio || 1;
		const stats = this.renderer.draw(this.camera, this.width, this.height, ratio);
		this.lastFrameMs = stats.milliseconds;
		this.element.dataset['frameMs'] = stats.milliseconds.toFixed(2);
		this.drawOverlay(ratio);
	}

	/** Measures `frames` frames of panning and zooming (the 60 fps check of ROADMAP P1-4). */
	async benchmark(frames = 120): Promise<{ averageMs: number; worstMs: number; fps: number }> {
		const window = getWindow(this.element);
		const start = { ...this.camera };
		const times: number[] = [];
		let last = performance.now();
		for (let i = 0; i < frames; i++) {
			await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
			const t = i / frames * Math.PI * 2;
			this.camera = { cx: start.cx + Math.cos(t) * 50 / start.scale, cy: start.cy + Math.sin(t) * 50 / start.scale, scale: start.scale * (1 + 0.5 * Math.sin(t)) };
			this.drawFrame();
			const now = performance.now();
			times.push(now - last);
			last = now;
		}
		this.camera = start;
		this.requestFrame();
		const draws = times.slice(1);
		const averageMs = draws.reduce((a, b) => a + b, 0) / draws.length;
		const result = { averageMs, worstMs: Math.max(...draws), fps: 1000 / averageMs };
		this.element.dataset['benchmarkFps'] = result.fps.toFixed(1);
		return result;
	}

	get frameMilliseconds(): number {
		return this.lastFrameMs;
	}

	private toWorld(x: number, y: number): [number, number] {
		return [this.camera.cx + (x - this.width / 2) / this.camera.scale, this.camera.cy + (y - this.height / 2) / this.camera.scale];
	}

	private toScreen(x: number, y: number): [number, number] {
		return [(x - this.camera.cx) * this.camera.scale + this.width / 2, (y - this.camera.cy) * this.camera.scale + this.height / 2];
	}

	private snap(value: number): number {
		const grid = GRID[this.kind];
		return Math.round(value / grid) * grid;
	}

	private dragPreview: { dx: number; dy: number } | undefined;

	private drawOverlay(ratio: number): void {
		const canvas = this.overlay;
		const w = Math.round(this.width * ratio), h = Math.round(this.height * ratio);
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, this.width, this.height);
		if (this.dragPreview) {
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
			ctx.setLineDash([4, 3]);
			for (const item of this.selection) {
				const box = item.bbox as Message;
				const [x0, y0] = this.toScreen(box.x0 + this.dragPreview.dx, box.y0 + this.dragPreview.dy);
				const [x1, y1] = this.toScreen(box.x1 + this.dragPreview.dx, box.y1 + this.dragPreview.dy);
				ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
			}
		}
		if (this.wire && this.wire.length >= 2) {
			ctx.strokeStyle = this.kind === 'schematic' ? 'rgba(0, 150, 0, 0.9)' : 'rgba(200, 52, 52, 0.9)';
			ctx.setLineDash([]);
			ctx.lineWidth = 2;
			ctx.beginPath();
			for (let i = 0; i < this.wire.length; i += 2) {
				const [x, y] = this.toScreen(this.wire[i], this.wire[i + 1]);
				if (i === 0) {
					ctx.moveTo(x, y);
				} else {
					ctx.lineTo(x, y);
				}
			}
			const [cx, cy] = this.toScreen(this.snap(this.cursorWorld[0]), this.snap(this.cursorWorld[1]));
			ctx.lineTo(cx, cy);
			ctx.stroke();
		}
	}

	// ---- Input -----------------------------------------------------------------------------

	private registerInput(): void {
		const target = this.overlay;
		this._register(addDisposableListener(target, EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			const rect = target.getBoundingClientRect();
			const x = e.clientX - rect.left, y = e.clientY - rect.top;
			const [wx, wy] = this.toWorld(x, y);
			const factor = Math.pow(1.0015, -e.deltaY);
			this.camera.scale = Math.min(Math.max(this.camera.scale * factor, 1e-9), 10);
			// Keep the world point under the cursor.
			this.camera.cx = wx - (x - this.width / 2) / this.camera.scale;
			this.camera.cy = wy - (y - this.height / 2) / this.camera.scale;
			this.requestFrame();
		}, { passive: false }));

		let drag: { button: number; x: number; y: number; cx: number; cy: number; moved: boolean; onSelection: boolean } | undefined;
		this._register(addDisposableListener(target, EventType.POINTER_DOWN, (e: PointerEvent) => {
			this.element.focus();
			target.setPointerCapture(e.pointerId);
			const rect = target.getBoundingClientRect();
			const [wx, wy] = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
			drag = {
				button: e.button, x: e.clientX, y: e.clientY, cx: this.camera.cx, cy: this.camera.cy, moved: false,
				onSelection: e.button === 0 && !this.wire && this.selection.some(item => inBox(item.bbox, wx, wy)),
			};
		}));
		this._register(addDisposableListener(target, EventType.POINTER_MOVE, (e: PointerEvent) => {
			const rect = target.getBoundingClientRect();
			this.cursorWorld = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
			if (this.wire) {
				this.requestFrame();
			}
			if (!drag) {
				return;
			}
			const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > DRAG_PIXELS) {
				drag.moved = true;
			}
			if (drag.button === 1 || drag.button === 2) {
				this.camera.cx = drag.cx - dx / this.camera.scale;
				this.camera.cy = drag.cy - dy / this.camera.scale;
				this.requestFrame();
			} else if (drag.onSelection && drag.moved) {
				this.dragPreview = { dx: this.snap(dx / this.camera.scale), dy: this.snap(dy / this.camera.scale) };
				this.requestFrame();
			}
		}));
		this._register(addDisposableListener(target, EventType.POINTER_UP, (e: PointerEvent) => {
			const current = drag;
			drag = undefined;
			if (!current) {
				return;
			}
			const rect = target.getBoundingClientRect();
			const [wx, wy] = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
			if (current.button === 0 && this.wire) {
				this.wire.push(this.snap(wx), this.snap(wy));
				this.requestFrame();
			} else if (current.button === 0 && current.onSelection && current.moved && this.dragPreview) {
				const { dx, dy } = this.dragPreview;
				this.dragPreview = undefined;
				if (dx !== 0 || dy !== 0) {
					void this.edit({ move: { uuids: this.selection.map(item => item.uuid), dx, dy } });
				}
				this.requestFrame();
			} else if (current.button === 0 && !current.moved) {
				void this.pick(wx, wy, e.shiftKey);
			} else if (current.button === 2 && !current.moved) {
				// A right-click (not a right-drag, which pans): the menu for what's under it.
				void this.showContextMenu(e.clientX, e.clientY, wx, wy);
			}
		}));
		this._register(addDisposableListener(target, EventType.CONTEXT_MENU, e => e.preventDefault()));
		this._register(addDisposableListener(target, EventType.DBLCLICK, () => {
			if (this.wire) {
				void this.finishWire();
			}
		}));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, (e: KeyboardEvent) => this.onKey(e)));
	}

	private onKey(e: KeyboardEvent): void {
		const ctrl = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		let handled = true;
		if (ctrl && key === 'z' && !e.shiftKey) {
			void this.undoRedo('undo');
		} else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
			void this.undoRedo('redo');
		} else if (ctrl && key === 's') {
			void this.save();
		} else if (ctrl) {
			handled = false;
		} else if (key === 'escape') {
			if (this.wire) {
				void this.finishWire();
			} else {
				void this.select([]);
			}
		} else if (key === 'home') {
			this.fit();
		} else if (key === 'r' && this.selection.length > 0) {
			void this.edit({ rotate: { uuids: this.selection.map(item => item.uuid), degrees: e.shiftKey ? -90 : 90 } });
		} else if ((key === 'delete' || key === 'backspace') && this.selection.length > 0) {
			const uuids = this.selection.map(item => item.uuid);
			this.selection = [];
			void this.edit({ delete: { uuids } });
		} else if (key === 'e' && this.selection.length === 1) {
			void this.editField('Value');
		} else if (key === 'f2' && this.selection.length === 1) {
			void this.editField('Reference');
		} else if (key === 'w') {
			this.wire = [];
			this.setStatus(this.kind === 'schematic'
				? localize('triage.eda.wireMode', "Wire: click points, double-click or Escape to finish")
				: localize('triage.eda.trackMode', "Track: click points, double-click or Escape to finish"));
		} else {
			handled = false;
		}
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	// ---- Selection and cross-probing -------------------------------------------------------

	/** The net of the selection (a pin's, a wire's or a label's), if any. */
	private selectedNet(): string | undefined {
		return this.selection.map(item => item.net as string | undefined).find(Boolean);
	}

	/** The right-click menu: what can be done with the net or part under the cursor, then the tab's actions. */
	private async showContextMenu(clientX: number, clientY: number, x: number, y: number): Promise<void> {
		let net: string | undefined;
		let reference: string | undefined;
		if (this.document) {
			try {
				const hit = await this.engine.call('hitTest', { document: this.document, x, y, tolerance: 5 / this.camera.scale });
				const items = hit.response.hitTest.items as Message[];
				net = items.map(item => item.net as string | undefined).find(Boolean);
				reference = items.map(item => item.reference as string | undefined).find(Boolean);
			} catch (error) {
				this.reportError(error);
			}
		}
		const actions: IAction[] = [];
		if (net && this.kind === 'schematic') {
			actions.push(toAction({ id: 'triage.eda.menu.renameNet', label: localize('triage.eda.menuRenameNet', "Rename Net “{0}”…", net), run: () => this.commandService.executeCommand(EDA_COMMANDS.renameNet, net) }));
		}
		if (reference) {
			actions.push(toAction({ id: 'triage.eda.menu.select', label: localize('triage.eda.menuSelect', "Select {0} in Schematic and Board", reference), run: () => this.commandService.executeCommand(EDA_COMMANDS.select, [reference], net) }));
		}
		if (actions.length > 0) {
			actions.push(new Separator());
		}
		actions.push(
			toAction({ id: 'triage.eda.menu.fit', label: localize('triage.eda.fit', "Fit"), run: () => this.fit() }),
			toAction({ id: 'triage.eda.menu.undo', label: localize('triage.eda.undo', "Undo"), run: () => this.undoRedo('undo') }),
			toAction({ id: 'triage.eda.menu.redo', label: localize('triage.eda.redo', "Redo"), run: () => this.undoRedo('redo') }),
			toAction({ id: 'triage.eda.menu.save', label: localize('triage.eda.save', "Save"), run: () => this.save() }),
			new Separator(),
			toAction({ id: 'triage.eda.menu.kicad', label: localize('triage.eda.menuKicad', "Edit in KiCad (Fallback Window)"), run: () => this.commandService.executeCommand(EDA_COMMANDS.openInKicad) }),
		);
		this.element.dataset['contextNet'] = net ?? '';
		this.contextMenuService.showContextMenu({ getAnchor: () => ({ x: clientX, y: clientY }), getActions: () => actions });
	}

	private async pick(x: number, y: number, add: boolean): Promise<void> {
		if (!this.document) {
			return;
		}
		try {
			const tolerance = 5 / this.camera.scale;
			const hit = await this.engine.call('hitTest', { document: this.document, x, y, tolerance });
			const items = hit.response.hitTest.items as Message[];
			// The smallest item first: a pad over its footprint, a pin over its symbol.
			let picked = items.slice(0, 1);
			if (picked.length === 1 && (picked[0].type === 'PAD' || picked[0].type === 'SCH_PIN' || picked[0].type === 'SCH_FIELD' || picked[0].type === 'PCB_FIELD')) {
				// Selecting a pad selects its part; the net still cross-probes.
				const part = items.find(item => item.reference && (item.type === 'FOOTPRINT' || item.type === 'SCH_SYMBOL'));
				if (part) {
					picked = [{ ...part, net: picked[0].net || part.net }];
				}
			}
			const selection = add ? [...this.selection, ...picked] : picked;
			await this.select(selection);
			const references = selection.map(item => item.reference as string).filter(Boolean);
			const net = picked[0]?.net as string | undefined;
			this.crossProbe.probe({ source: this.kind as ProbeSource, references, net: net || undefined });
		} catch (error) {
			this.reportError(error);
		}
	}

	private async select(items: Message[]): Promise<void> {
		this.selection = items;
		const result = await this.engine.call('setSelection', { document: this.document, uuids: items.map(item => item.uuid) });
		this.applyChunks(result);
		this._onDidSelect.fire(items);
		this.element.dataset['selection'] = items.map(item => item.reference || item.type).join(',');
		this.setStatus(items.length === 0 ? '' : items.map(item => item.description).join(' · '));
	}

	/** Selects the parts with these references (cross-probe from another view). */
	async selectReferences(references: readonly string[], net?: string): Promise<void> {
		if (!this.document) {
			return;
		}
		try {
			const found = await this.engine.call('getItems', { document: this.document, references: [...references] });
			const items = found.response.items.items as Message[];
			await this.select(items);
			if (net !== undefined) {
				const lit = await this.engine.call('highlight', { document: this.document, net });
				this.applyChunks(lit);
			}
		} catch (error) {
			this.reportError(error);
		}
	}

	// ---- Edits -----------------------------------------------------------------------------

	private async edit(action: Message): Promise<void> {
		if (!this.document) {
			return;
		}
		try {
			const result = await this.engine.call('edit', { document: this.document, ...action });
			this.applyChunks(result);
			await this.refreshSelection();
			this.markModified(result.response.edit?.modified ?? true);
		} catch (error) {
			this.reportError(error);
		}
	}

	private async refreshSelection(): Promise<void> {
		if (this.selection.length === 0) {
			return;
		}
		const found = await this.engine.call('getItems', { document: this.document, uuids: this.selection.map(item => item.uuid) });
		this.selection = found.response.items.items as Message[];
	}

	private async undoRedo(which: 'undo' | 'redo'): Promise<void> {
		if (!this.document) {
			return;
		}
		try {
			const result = await this.engine.call(which, { document: this.document });
			this.applyChunks(result);
			await this.refreshSelection();
			this.markModified(result.response.edit?.modified ?? true);
		} catch (error) {
			this.reportError(error);
		}
	}

	async save(): Promise<void> {
		if (!this.document) {
			return;
		}
		try {
			// Our own write must not trigger a reload (see watch()).
			this.saving = true;
			try {
				await this.engine.call('save', { document: this.document });
				if (this.path) {
					const stat = await this.fileService.stat(URI.file(this.path));
					this.ownSave = { mtime: stat.mtime, size: stat.size };
				}
			} finally {
				this.saving = false;
			}
			this.markModified(false);
			this.setStatus(localize('triage.eda.saved', "Saved {0}", basename(this.path ?? '')));
			this.element.dataset['saves'] = String(Number(this.element.dataset['saves'] ?? '0') + 1);
		} catch (error) {
			this.reportError(error);
		}
	}

	private async editField(field: 'Value' | 'Reference'): Promise<void> {
		const item = this.selection[0];
		const current = field === 'Value' ? item.value : item.reference;
		const text = await this.quickInputService.input({
			value: current,
			prompt: field === 'Value'
				? localize('triage.eda.editValue', "Value of {0}", item.reference || item.type)
				: localize('triage.eda.editReference', "Reference of {0}", item.reference || item.type),
		});
		if (text !== undefined && text !== current) {
			await this.edit({ setField: { uuid: item.uuid, field, text } });
		}
	}

	private async finishWire(): Promise<void> {
		const points = this.wire ?? [];
		this.wire = undefined;
		this.setStatus('');
		this.requestFrame();
		if (points.length >= 4) {
			await this.edit(this.kind === 'schematic'
				? { addWire: { points, sheet: this.sheet } }
				: { addTrack: { points, width: 0, layer: 0, net: '' } });
		}
	}

	/** Programmatic edits for commands and tests (the same path as the keys above). */
	runEdit(action: Message): Promise<void> {
		return this.edit(action);
	}

	private markModified(modified: boolean): void {
		if (this.info) {
			this.info = { ...this.info, modified };
			this.renderToolbar();
		}
		this.element.dataset['modified'] = String(modified);
	}

	// ---- Messages --------------------------------------------------------------------------

	private setStatus(text: string): void {
		this.status.textContent = text;
	}

	private showError(message: string): void {
		this.element.dataset['state'] = 'error';
		this.element.dataset['error'] = message;
		this.setStatus(message);
	}

	private reportError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.setStatus(message);
		if (!(error instanceof EdaEngineError)) {
			this.notificationService.error(message);
		}
	}

	override dispose(): void {
		if (this.document) {
			void this.engine.call('closeDocument', { document: this.document }).catch(() => undefined);
		}
		super.dispose();
	}
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function cssColor(rgba: number): string {
	return `rgba(${(rgba >>> 24) & 255}, ${(rgba >>> 16) & 255}, ${(rgba >>> 8) & 255}, ${((rgba & 255) / 255).toFixed(2)})`;
}

function inBox(box: Message | undefined, x: number, y: number): boolean {
	return !!box && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}
