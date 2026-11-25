/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Commands of the Schematic and Board tabs (ROADMAP P1-4 … P1-7).
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { ITriageEdaEngineService } from '../../common/eda/edaEngine.js';
import { TRIAGE_CATEGORY } from '../../common/triage.js';
import { TriageViewEditor } from '../triageViewEditor.js';
import { EdaDocumentView, EdaViewKind } from './edaDocumentView.js';

export const EDA_COMMANDS = {
	benchmark: 'triage.eda.benchmarkView',
	reload: 'triage.eda.reload',
	renameNet: 'triage.eda.renameNet',
	edit: 'triage.eda.edit',
	save: 'triage.eda.save',
	openInKicad: 'triage.eda.openInKicad',
	select: 'triage.eda.selectReferences',
	restartEngine: 'triage.eda.restartEngine',
} as const;

/** The engine views in visible tabs, the active one first. */
export function edaViews(editorService: IEditorService, kind?: EdaViewKind): EdaDocumentView[] {
	const panes = [editorService.activeEditorPane, ...editorService.visibleEditorPanes];
	const views: EdaDocumentView[] = [];
	for (const pane of panes) {
		const view = pane instanceof TriageViewEditor ? pane.edaView : undefined;
		if (view && !views.includes(view) && (!kind || view.kind === kind)) {
			views.push(view);
		}
	}
	return views;
}

export function registerEdaCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.benchmark, title: localize2('triage.eda.benchmark', "Benchmark Schematic and Board Views"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<{ kind: string; fps: number; averageMs: number; worstMs: number }[]> {
			const views = edaViews(accessor.get(IEditorService));
			const notifications = accessor.get(INotificationService);
			const results = [];
			for (const view of views) {
				const result = await view.benchmark();
				results.push({ kind: view.kind, ...result });
			}
			notifications.info(results.length === 0
				? localize('triage.eda.noViews', "Open the Schematic or Board tab first.")
				: results.map(r => localize('triage.eda.benchmarkResult', "{0}: {1} fps (average {2} ms, worst {3} ms)", r.kind, r.fps.toFixed(0), r.averageMs.toFixed(1), r.worstMs.toFixed(1))).join(' · '));
			return results;
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.reload, title: localize2('triage.eda.reloadCommand', "Reload Schematic and Board from Disk"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await Promise.all(edaViews(accessor.get(IEditorService)).map(view => view.reload()));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.renameNet, title: localize2('triage.eda.renameNetCommand', "Rename Net in the Schematic"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor, from?: string, to?: string): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const view = edaViews(accessor.get(IEditorService), 'schematic')[0];
			if (!view) {
				accessor.get(INotificationService).info(localize('triage.eda.noSchematic', "Open the Schematic tab first."));
				return;
			}
			from ??= await quickInput.input({ prompt: localize('triage.eda.renameFrom', "Net to rename (its label text)") });
			if (!from) {
				return;
			}
			to ??= await quickInput.input({ prompt: localize('triage.eda.renameTo', "New name for {0}", from), value: from });
			if (!to || to === from) {
				return;
			}
			await view.runEdit({ renameNet: { from, to } });
			await view.save();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.edit, title: localize2('triage.eda.editCommand', "Edit the Schematic or Board (engine command)"), category: TRIAGE_CATEGORY, f1: false });
		}
		async run(accessor: ServicesAccessor, kind: EdaViewKind, action: Record<string, unknown>): Promise<void> {
			const view = edaViews(accessor.get(IEditorService), kind)[0];
			await view?.runEdit(action);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.save, title: localize2('triage.eda.saveCommand', "Save Schematic and Board"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await Promise.all(edaViews(accessor.get(IEditorService)).map(view => view.save()));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.select, title: localize2('triage.eda.selectCommand', "Select Parts in Schematic and Board"), category: TRIAGE_CATEGORY, f1: false });
		}
		async run(accessor: ServicesAccessor, references: string[], net?: string): Promise<void> {
			await Promise.all(edaViews(accessor.get(IEditorService)).map(view => view.selectReferences(references, net)));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.openInKicad, title: localize2('triage.eda.openInKicadCommand', "Edit in KiCad (Fallback Window)"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const view = edaViews(accessor.get(IEditorService))[0];
			const path = view?.documentPath;
			if (!path) {
				accessor.get(INotificationService).info(localize('triage.eda.noDocument', "Open the Schematic or Board tab first."));
				return;
			}
			await accessor.get(ITriageEdaEngineService).openInKicad(path);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: EDA_COMMANDS.restartEngine, title: localize2('triage.eda.restartEngine', "Kill the KiCad Engine (Restart Test)"), category: TRIAGE_CATEGORY, f1: true });
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ITriageEdaEngineService).kill();
		}
	});
}
