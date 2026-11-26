/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Pin map sync and the link graph v0 (ROADMAP P1-5, PLAN §4.5 items 1 and 2).
 *
 *  Whenever the schematic changes (an edit in Triage, or a save in KiCad), its
 *  netlist comes from KiCad's engine, the Rust model maps the nets to the board's
 *  pins, and Triage writes firmware/generated/board_pins.h and .triage/links.json.
 *  Firmware sources get diagnostics for pins the circuit doesn't connect or that
 *  can't do what the code asks (no PWM, not analog). Hovering a net constant in the
 *  code shows its net; putting the cursor on it selects the net in the schematic
 *  and board, and selecting a net there highlights it in the code.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../base/common/async.js';
import { VSBuffer } from '../../base/common/buffer.js';
import { MarkdownString } from '../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { URI } from '../../base/common/uri.js';
import { ICodeEditor } from '../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { Range } from '../../editor/common/core/range.js';
import { IModelDeltaDecoration } from '../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../editor/common/services/model.js';
import { localize } from '../../nls.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IMarkerService, MarkerSeverity } from '../../platform/markers/common/markers.js';
import { IWorkbenchContribution } from '../../workbench/common/contributions.js';
import { ITriageCrossProbeService } from '../common/eda/crossProbe.js';
import { ITriageEdaEngineService } from '../common/eda/edaEngine.js';
import { Message } from '../common/eda/protobuf.js';
import { IPinMap, IPinMapComponent, ITriageProject, ITriageProjectService } from '../common/projectModel.js';

const MARKER_OWNER = 'triage.pinmap';
const SOURCE_EXTENSIONS = /\.(c|cc|cpp|cxx|h|hh|hpp|ino)$/i;
const HEADER = join('generated', 'board_pins.h');

interface ProjectFiles {
	readonly root: string;
	readonly board: string;
	readonly schematic: string;
	readonly pcb: string;
	readonly firmware: string;
}

function projectFiles(project: ITriageProject): ProjectFiles | undefined {
	const electronics = project.domains.find(domain => domain.id === 'electronics');
	const code = project.domains.find(domain => domain.id === 'code');
	const kicad = electronics?.files.find(file => file.path.endsWith('.kicad_pro'));
	if (!project.board || !kicad || !code?.configured) {
		return undefined;
	}
	const base = join(project.root, kicad.path.replace(/\.kicad_pro$/, ''));
	return { root: project.root, board: project.board, schematic: `${base}.kicad_sch`, pcb: `${base}.kicad_pcb`, firmware: join(project.root, code.path) };
}

export class TriagePinMapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.triagePinMap';

	private files: ProjectFiles | undefined;
	private map: IPinMap | undefined;
	/** Documents this contribution opened itself (no view had them). */
	private readonly ownDocuments = new Map<string, number>();
	private readonly updater: RunOnceScheduler;
	private readonly projectStore = this._register(new DisposableStore());
	private readonly decorations = new Map<ICodeEditor, string[]>();
	private lastHeader = '';
	private lastProbedConstant: string | undefined;
	/** When the last change that needs a new pin map arrived (for the 2 s budget). */
	private changedAt = 0;

	constructor(
		@ITriageProjectService private readonly projectService: ITriageProjectService,
		@ITriageEdaEngineService private readonly engine: ITriageEdaEngineService,
		@ITriageCrossProbeService private readonly crossProbe: ITriageCrossProbeService,
		@IFileService private readonly fileService: IFileService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IModelService private readonly modelService: IModelService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.updater = this._register(new RunOnceScheduler(() => void this.update(), 150));
		this._register(this.projectService.onDidChangeState(() => this.onProject()));
		this._register(this.engine.onDidChangeDocument(({ path }) => {
			if (path === this.files?.schematic) {
				this.schedule();
			}
		}));
		this._register(this.engine.onDidRestart(() => {
			this.ownDocuments.clear();
			this.schedule();
		}));
		this._register(this.modelService.onModelAdded(model => this.watchModel(model.uri)));
		for (const model of this.modelService.getModels()) {
			this.watchModel(model.uri);
		}
		this._register(languageFeaturesService.hoverProvider.register([{ language: 'cpp' }, { language: 'c' }, { language: 'arduino' }], {
			provideHover: (model, position) => {
				const word = model.getWordAtPosition(position);
				const pin = word && this.map?.pins.find(p => p.constant === word.word);
				if (!word || !pin) {
					return undefined;
				}
				const abilities = [pin.digital ? 'digital' : '', pin.analog ? 'analog' : '', pin.pwm ? 'PWM' : '', pin.role ?? ''].filter(Boolean).join(', ');
				return {
					range: new Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
					contents: [new MarkdownString(localize('triage.pinmap.hover', "**{0}**: net `{1}` on {2} of {3} ({4}), pin {5}", pin.constant ?? '', pin.net, pin.pin, this.map?.reference ?? '', abilities, String(pin.number)))],
				};
			},
		}));
		this._register(this.codeEditorService.onCodeEditorAdd(editor => this.watchEditor(editor)));
		for (const editor of this.codeEditorService.listCodeEditors()) {
			this.watchEditor(editor);
		}
		this._register(this.crossProbe.onDidProbe(probe => {
			if (probe.source !== 'code') {
				this.highlightNet(probe.net);
			}
		}));
		this.onProject();
	}

	private onProject(): void {
		const state = this.projectService.state;
		const files = state.kind === 'project' ? projectFiles(state.project) : undefined;
		if (files?.schematic === this.files?.schematic && files?.firmware === this.files?.firmware) {
			return;
		}
		this.files = files;
		this.projectStore.clear();
		this.map = undefined;
		if (!files) {
			return;
		}
		// A save in stock KiCad (the fallback window) or anywhere else.
		const schematic = URI.file(files.schematic);
		this.projectStore.add(this.fileService.watch(schematic));
		this.projectStore.add(this.fileService.watch(URI.file(files.firmware), { recursive: true, excludes: [] }));
		this.projectStore.add(this.fileService.onDidFilesChange(event => {
			if (event.contains(schematic)) {
				const own = this.ownDocuments.get(files.schematic);
				if (own !== undefined) {
					void this.engine.call('reload', { document: own }).catch(() => this.ownDocuments.delete(files.schematic));
				}
				this.schedule();
			} else if (event.rawUpdated.some(uri => SOURCE_EXTENSIONS.test(uri.fsPath) && !uri.fsPath.endsWith(HEADER))) {
				this.schedule();
			}
		}));
		this.schedule();
	}

	private watchModel(uri: URI): void {
		const model = this.modelService.getModel(uri);
		if (!model || !SOURCE_EXTENSIONS.test(uri.fsPath)) {
			return;
		}
		const listener = model.onDidChangeContent(() => {
			if (this.files && uri.fsPath.startsWith(this.files.firmware)) {
				this.schedule();
			}
		});
		this._register(model.onWillDispose(() => listener.dispose()));
	}

	private watchEditor(editor: ICodeEditor): void {
		const listener = editor.onDidChangeCursorPosition(event => {
			const model = editor.getModel();
			const word = model?.getWordAtPosition(event.position);
			const pin = word && this.map?.pins.find(p => p.constant === word.word);
			if (pin && pin.constant !== this.lastProbedConstant) {
				// Code -> schematic and board: select the board symbol and light the net.
				this.lastProbedConstant = pin.constant;
				this.crossProbe.probe({ source: 'code', references: this.map ? [this.map.reference] : [], net: pin.net });
			} else if (!pin) {
				this.lastProbedConstant = undefined;
			}
		});
		this._register(editor.onDidDispose(() => {
			listener.dispose();
			this.decorations.delete(editor);
		}));
	}

	/** Schematic or board -> code: highlight the net's constant in visible code editors. */
	private highlightNet(net: string | undefined): void {
		const constant = net ? this.map?.pins.find(p => p.net === net)?.constant : undefined;
		for (const editor of this.codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			const old = this.decorations.get(editor) ?? [];
			const next: IModelDeltaDecoration[] = [];
			if (model && constant && SOURCE_EXTENSIONS.test(model.uri.fsPath)) {
				for (const match of model.findMatches(constant, false, false, true, '_', false)) {
					next.push({ range: match.range, options: { description: 'triage-net', inlineClassName: 'triage-net-highlight' } });
				}
			}
			this.decorations.set(editor, editor.deltaDecorations(old, next));
		}
	}

	private schedule(): void {
		if (!this.changedAt) {
			this.changedAt = performance.now();
		}
		this.updater.schedule();
	}

	/** The schematic's live netlist: from a view's document, or one opened here. */
	private async netlist(path: string): Promise<Message> {
		let document = this.engine.documentFor(path);
		if (document === undefined) {
			const opened = await this.engine.call('openDocument', { path });
			document = opened.response.document.document as number;
			this.ownDocuments.set(path, document);
		}
		return (await this.engine.call('getNetlist', { document })).response.netlist;
	}

	private async firmwareSources(root: string): Promise<{ path: string; text: string }[]> {
		const out: { path: string; text: string }[] = [];
		const visit = async (dir: URI, depth: number) => {
			const stat = await this.fileService.resolve(dir).catch(() => undefined);
			for (const child of stat?.children ?? []) {
				if (child.isDirectory && depth < 4 && child.name !== 'generated' && !child.name.startsWith('.')) {
					await visit(child.resource, depth + 1);
				} else if (SOURCE_EXTENSIONS.test(child.name)) {
					// Unsaved edits count: the editor's text wins over the file.
					const model = this.modelService.getModel(child.resource);
					const text = model ? model.getValue() : (await this.fileService.readFile(child.resource)).value.toString();
					out.push({ path: child.resource.fsPath, text });
				}
			}
		};
		await visit(URI.file(root), 0);
		return out;
	}

	private async update(): Promise<void> {
		const files = this.files;
		if (!files) {
			return;
		}
		const started = this.changedAt || performance.now();
		this.changedAt = 0;
		try {
			const netlist = await this.netlist(files.schematic);
			const components: IPinMapComponent[] = (netlist.components as Message[]).map(c => ({
				reference: c.reference, libId: c.libId, footprint: c.footprint,
				pins: (c.pins as Message[]).map(p => ({ number: p.number, name: p.name, net: p.net })),
			}));
			const sources = await this.firmwareSources(files.firmware);
			const relativeSchematic = files.schematic.slice(files.root.length + 1).replace(/\\/g, '/');
			const map = await this.projectService.pinMap(files.board, relativeSchematic, components, sources);
			this.map = map;

			if (map.header !== this.lastHeader) {
				const header = URI.file(join(files.firmware, HEADER));
				const current = await this.fileService.readFile(header).then(content => content.value.toString(), () => '');
				if (current !== map.header) {
					await this.fileService.writeFile(header, VSBuffer.fromString(map.header));
				}
				this.lastHeader = map.header;
			}
			await this.writeLinks(files, map, components);
			this.publishDiagnostics(sources.map(source => source.path), map);
			this.logService.info(`[triage] pin map: ${map.pins.filter(p => p.connected).length} connected pins, ${map.diagnostics.length} diagnostic(s), ${(performance.now() - started).toFixed(0)} ms after the change`);
		} catch (error) {
			this.logService.warn(`[triage] pin map: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private publishDiagnostics(paths: string[], map: IPinMap): void {
		for (const path of paths) {
			const markers = map.diagnostics.filter(d => d.path === path).map(d => ({
				severity: d.severity === 'error' ? MarkerSeverity.Error : MarkerSeverity.Warning,
				message: d.message,
				source: 'Triage pin map',
				startLineNumber: d.line,
				startColumn: d.column,
				endLineNumber: d.line,
				endColumn: d.endColumn,
			}));
			this.markerService.changeOne(MARKER_OWNER, URI.file(path), markers);
		}
	}

	/** .triage/links.json, the cross-domain link graph v0 (PLAN §4.4): parts and nets by stable id. */
	private async writeLinks(files: ProjectFiles, map: IPinMap, components: IPinMapComponent[]): Promise<void> {
		const nets = new Map<string, string[]>();
		for (const component of components) {
			for (const pin of component.pins) {
				if (pin.net) {
					nets.set(pin.net, [...(nets.get(pin.net) ?? []), `${component.reference}.${pin.number}`]);
				}
			}
		}
		const links = {
			format: 0,
			generator: 'Triage (ROADMAP P1-5)',
			schematic: files.schematic.slice(files.root.length + 1).replace(/\\/g, '/'),
			board: { profile: map.board, symbol: map.reference },
			components: components.map(c => ({ reference: c.reference, symbol: c.libId, footprint: c.footprint })),
			nets: [...nets].sort(([a], [b]) => a.localeCompare(b)).map(([name, pins]) => {
				const pin = map.pins.find(p => p.net === name);
				return { name, pins, firmware: pin?.constant ? { constant: pin.constant, pin: pin.pin, number: pin.number } : undefined };
			}),
		};
		const text = `${JSON.stringify(links, null, '\t')}\n`;
		const uri = URI.file(join(files.root, '.triage', 'links.json'));
		const current = await this.fileService.readFile(uri).then(content => content.value.toString(), () => '');
		if (current !== text) {
			await this.fileService.writeFile(uri, VSBuffer.fromString(text));
		}
	}
}
