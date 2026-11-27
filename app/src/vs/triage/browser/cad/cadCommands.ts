/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Commands of the 3D tab (ROADMAP P2-3 … P2-5).
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { TRIAGE_CATEGORY } from '../../common/triage.js';
import { TriageViewEditor } from '../triageViewEditor.js';
import { CadView } from './cadView.js';

export const CAD_COMMANDS = {
	benchmark: 'triage.cad.benchmarkView',
	exportEnclosure: 'triage.cad.exportEnclosure',
	setPartHeight: 'triage.cad.setPartHeight',
	check: 'triage.cad.checkFit',
} as const;

/** The 3D views in visible tabs, the active one first. */
export function cadViews(editorService: IEditorService): CadView[] {
	const panes = [editorService.activeEditorPane, ...editorService.visibleEditorPanes];
	const views: CadView[] = [];
	for (const pane of panes) {
		const view = pane instanceof TriageViewEditor ? pane.cadView : undefined;
		if (view && !views.includes(view)) {
			views.push(view);
		}
	}
	return views;
}

export function registerCadCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CAD_COMMANDS.benchmark, title: localize2('triage.cad.benchmark', "Benchmark the 3D View"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<{ fps: number; cpuMs: number } | undefined> {
			const view = cadViews(accessor.get(IEditorService))[0];
			const notifications = accessor.get(INotificationService);
			if (!view) {
				notifications.info(localize('triage.cad.noView', "Open the 3D tab first."));
				return undefined;
			}
			const result = await view.benchmark();
			view.element.dataset['benchmarkFps'] = result.fps.toFixed(1);
			notifications.info(localize('triage.cad.benchmarkResult', "3D view: {0} fps ({1} ms of drawing per frame)", result.fps.toFixed(0), result.cpuMs.toFixed(2)));
			return result;
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CAD_COMMANDS.exportEnclosure, title: localize2('triage.cad.exportCommand', "Export the Enclosure for Printing (STL)"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<string[]> {
			const view = cadViews(accessor.get(IEditorService))[0];
			if (!view) {
				accessor.get(INotificationService).info(localize('triage.cad.noView', "Open the 3D tab first."));
				return [];
			}
			return view.exportEnclosure();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CAD_COMMANDS.setPartHeight, title: localize2('triage.cad.heightCommand', "Set a Part's Height (3D and Fit Checks)"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor, reference?: string, height?: string): Promise<void> {
			// The accessor is only valid until the first await.
			const view = cadViews(accessor.get(IEditorService))[0];
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			if (!view) {
				notifications.info(localize('triage.cad.noView', "Open the 3D tab first."));
				return;
			}
			// Pick the part with the mouse (ROADMAP PA-1); typing a reference still works.
			const parts = view.boardReferences();
			if (!reference && parts.length > 0) {
				reference = (await quickInput.pick(parts.map(label => ({ label })), { placeHolder: localize('triage.cad.heightPick', "The part whose height to set") }))?.label;
			}
			reference ??= await quickInput.input({ prompt: localize('triage.cad.heightReference', "Part reference (Q1, J1 …)") });
			if (!reference) {
				return;
			}
			height ??= await quickInput.input({ prompt: localize('triage.cad.heightValue', "Height of {0} above the board, in mm", reference) });
			if (!height) {
				return;
			}
			try {
				await view.setPartHeight(reference.trim(), Number.parseFloat(height));
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CAD_COMMANDS.check, title: localize2('triage.cad.checkCommand', "Check Fit and Clearance in 3D"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<number> {
			const view = cadViews(accessor.get(IEditorService))[0];
			return view ? view.checkFit() : 0;
		}
	});
}
