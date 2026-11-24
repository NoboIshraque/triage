/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Placeholder tabs of the Engineering layout. Each later work package replaces
 *  its tab with the real editor (schematic, board, 3D, simulation).
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension, reset } from '../../base/browser/dom.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { IEditorOptions } from '../../platform/editor/common/editor.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { EditorPane } from '../../workbench/browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../workbench/common/editor.js';
import { EditorInput } from '../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../workbench/services/editor/common/editorGroupsService.js';
import { ITriageView, TRIAGE_VIEW_SCHEME, triageView } from '../common/triage.js';

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

export class TriageViewEditor extends EditorPane {
	static readonly ID = 'workbench.editor.triageView';

	private container!: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
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
		reset(
			this.container,
			$('.triage-view-card', undefined,
				$(`span${ThemeIcon.asCSSSelector(view.icon)}.triage-view-icon`),
				$('h2', undefined, view.label),
				$('p.triage-view-summary', undefined, view.summary),
				$('p.triage-view-arrives', undefined, view.arrives),
			),
		);
	}

	override layout(dimension: Dimension): void {
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
	}
}
