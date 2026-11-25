/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The tabs of the Engineering layout. Schematic and Board show the project's
 *  KiCad files through the EDA engine (ROADMAP P1-4); 3D and Sim are still
 *  placeholders that say which work package fills them.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension, reset } from '../../base/browser/dom.js';
import { MutableDisposable } from '../../base/common/lifecycle.js';
import { join } from '../../base/common/path.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { IEditorOptions } from '../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { localize } from '../../nls.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { EditorPane } from '../../workbench/browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../workbench/common/editor.js';
import { EditorInput } from '../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../workbench/services/editor/common/editorGroupsService.js';
import { ITriageProjectService, TriageProjectState } from '../common/projectModel.js';
import { ITriageView, TRIAGE_VIEW_SCHEME, TriageViewKind, triageView } from '../common/triage.js';
import { EdaDocumentView } from './eda/edaDocumentView.js';

export class TriageViewInput extends EditorInput {
	static readonly ID = 'workbench.input.triageView';

	private readonly _resource: URI;

	constructor(readonly view: ITriageView) {
		super();
		this._resource = URI.from({ scheme: TRIAGE_VIEW_SCHEME, path: `/${view.kind}` });
	}

	get typeId(): string {
		return TriageViewInput.ID;
	}

	get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return this.view.label;
	}

	override getIcon(): ThemeIcon {
		return this.view.icon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof TriageViewInput && other.view.kind === this.view.kind;
	}
}

/** Restores the tabs of the Engineering layout after a reload. */
export class TriageViewInputSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof TriageViewInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof TriageViewInput ? JSON.stringify({ kind: input.view.kind }) : undefined;
	}

	deserialize(_instantiationService: unknown, serialized: string): EditorInput | undefined {
		try {
			const view = triageView((JSON.parse(serialized) as { kind?: string }).kind ?? '');
			return view ? new TriageViewInput(view) : undefined;
		} catch {
			return undefined;
		}
	}
}

/** The project's KiCad file for a tab: <project>.kicad_sch or <project>.kicad_pcb. */
export function kicadFileFor(state: TriageProjectState, kind: TriageViewKind): string | undefined {
	if (state.kind !== 'project') {
		return undefined;
	}
	const electronics = state.project.domains.find(domain => domain.id === 'electronics');
	const project = electronics?.files.find(file => file.path.endsWith('.kicad_pro'));
	if (!project) {
		return undefined;
	}
	const extension = kind === TriageViewKind.Schematic ? '.kicad_sch' : '.kicad_pcb';
	const domainPath = electronics?.path && !project.path.startsWith(electronics.path) ? electronics.path : '';
	return join(state.project.root, domainPath, project.path.replace(/\.kicad_pro$/, extension));
}

export class TriageViewEditor extends EditorPane {
	static readonly ID = 'workbench.editor.triageView';

	private container!: HTMLElement;
	private readonly eda = this._register(new MutableDisposable<EdaDocumentView>());
	private readonly projectListener = this._register(new MutableDisposable());
	private dimension: Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITriageProjectService private readonly projectService: ITriageProjectService,
	) {
		super(TriageViewEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.triage-view-editor'));
	}

	override async setInput(input: TriageViewInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const view = input.view;
		this.container.dataset['triageView'] = view.kind;
		if (view.kind === TriageViewKind.Schematic || view.kind === TriageViewKind.Board) {
			this.projectListener.value = this.projectService.onDidChangeState(() => this.showKicad(view));
			if (this.projectService.state.kind === 'none') {
				void this.projectService.refresh();
			}
			this.showKicad(view);
			return;
		}
		this.eda.clear();
		this.projectListener.clear();
		this.showCard(view);
	}

	/** Engine views of Schematic and Board; the card while there is no KiCad file. */
	private showKicad(view: ITriageView): void {
		const file = kicadFileFor(this.projectService.state, view.kind);
		if (!file) {
			this.eda.clear();
			this.showCard(view, this.projectService.state.kind === 'loading'
				? localize('triage.view.loadingProject', "Loading the project…")
				: localize('triage.view.noKicad', "Open a Triage project whose triage.toml names a KiCad project ([electronics] kicad_project)."));
			return;
		}
		if (this.eda.value?.documentPath === file) {
			return;
		}
		const kind = view.kind === TriageViewKind.Schematic ? 'schematic' : 'board';
		const edaView = this.instantiationService.createInstance(EdaDocumentView, kind);
		this.eda.value = edaView;
		reset(this.container, edaView.element);
		if (this.dimension) {
			edaView.layout(this.dimension.width, this.dimension.height);
		}
		void edaView.open(file);
	}

	private showCard(view: ITriageView, note?: string): void {
		reset(
			this.container,
			$('.triage-view-card', undefined,
				$(`span${ThemeIcon.asCSSSelector(view.icon)}.triage-view-icon`),
				$('h2', undefined, view.label),
				$('p.triage-view-summary', undefined, view.summary),
				$('p.triage-view-arrives', undefined, note ?? view.arrives),
			),
		);
	}

	/** The engine view in this tab, if it shows one (commands and tests use it). */
	get edaView(): EdaDocumentView | undefined {
		return this.eda.value;
	}

	override focus(): void {
		super.focus();
		this.eda.value?.element.focus();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
		this.eda.value?.layout(dimension.width, dimension.height);
	}
}
