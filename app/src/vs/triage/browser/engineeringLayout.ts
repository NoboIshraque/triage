/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Engineering layout: Code beside Schematic, Board, 3D and Sim, in one window.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { Codicon } from '../../base/common/codicons.js';
import { localize2 } from '../../nls.js';
import { Action2, MenuId } from '../../platform/actions/common/actions.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { ActiveEditorContext } from '../../workbench/common/contextkeys.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { EditorGroupLayout, GroupOrientation, GroupsArrangement, GroupsOrder, IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { AUX_WINDOW_GROUP, IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { ENGINEERING_LAYOUT_COMMAND_ID, ENGINEERING_VIEWS, ENGINEERING_WINDOWS_COMMAND_ID, MOVE_EDITOR_INTO_NEW_WINDOW_COMMAND_ID, POP_OUT_VIEW_COMMAND_ID, TRIAGE_CATEGORY, TriageViewKind } from '../common/triage.js';
import { TriageViewEditor, TriageViewInput } from './triageViewEditor.js';

/**
 * Code on the left (40 %), then two columns: Schematic over 3D, Board over Sim.
 * The same picture as two rows, but with the two-level tree VS Code's own
 * "Grid (2x2)" layout uses; a three-level tree (rows inside a column) left the
 * top row squeezed. Sizes are fractions of the whole editor area
 * (getDimensions in vs/base/browser/ui/grid/grid.ts).
 */
export const ENGINEERING_LAYOUT: EditorGroupLayout = {
	orientation: GroupOrientation.HORIZONTAL,
	groups: [
		{ size: 0.4 },
		{ size: 0.3, groups: [{ size: 0.5 }, { size: 0.5 }] },
		{ size: 0.3, groups: [{ size: 0.5 }, { size: 0.5 }] },
	],
};

/** Which leaf group (in grid order: top to bottom, left to right) shows each tab. */
const GROUP_INDEX: Record<TriageViewKind, number> = {
	[TriageViewKind.Code]: 0,
	[TriageViewKind.Schematic]: 1,
	[TriageViewKind.ThreeD]: 2,
	[TriageViewKind.Board]: 3,
	[TriageViewKind.Sim]: 4,
};

export class OpenEngineeringLayoutAction extends Action2 {
	constructor() {
		super({
			id: ENGINEERING_LAYOUT_COMMAND_ID,
			title: localize2('triage.engineeringLayout', "Open Engineering Layout"),
			category: TRIAGE_CATEGORY,
			icon: Codicon.layout,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const editorService = accessor.get(IEditorService);

		editorGroupsService.applyLayout(ENGINEERING_LAYOUT);
		const groups = editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
		await Promise.all(ENGINEERING_VIEWS.map(view => {
			const group = groups[Math.min(GROUP_INDEX[view.kind], groups.length - 1)];
			return editorService.openEditor(new TriageViewInput(view), { pinned: true, preserveFocus: true }, group);
		}));
		// The sizes above didn't survive opening the tabs (the top row came out
		// squeezed in CI screenshots), so even them out once everything is open.
		editorGroupsService.arrangeGroups(GroupsArrangement.EVEN);
	}
}

/**
 * The same views, each in a window of its own (for a second screen): Code stays
 * in this window, Schematic, Board, 3D and Sim open in new windows. Any tab can
 * also be dragged out of the window, or popped out with its title-bar button.
 */
export class OpenEngineeringWindowsAction extends Action2 {
	constructor() {
		super({
			id: ENGINEERING_WINDOWS_COMMAND_ID,
			title: localize2('triage.engineeringWindows', "Open Engineering Views in Separate Windows"),
			category: TRIAGE_CATEGORY,
			icon: Codicon.window,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const [code, ...others] = ENGINEERING_VIEWS;
		await editorService.openEditor(new TriageViewInput(code), { pinned: true });
		for (const view of others) {
			// A view already open in a tab moves (as "Move into New Window" does), so it
			// isn't shown twice; the group it leaves closes when empty.
			const open = editorGroupsService.groups
				.flatMap(group => group.editors.map(editor => ({ group, editor })))
				.find(({ editor }) => editor instanceof TriageViewInput && editor.view.kind === view.kind);
			if (open && open.group.windowId !== mainWindow.vscodeWindowId) {
				continue; // already in a window of its own
			}
			if (open) {
				const part = await editorGroupsService.createAuxiliaryEditorPart();
				open.group.moveEditor(open.editor, part.activeGroup, { pinned: true });
			} else {
				await editorService.openEditor(new TriageViewInput(view), { pinned: true }, AUX_WINDOW_GROUP);
			}
		}
	}
}

/** Title-bar button on Triage's tabs: move this view into a window of its own. */
export class PopOutViewAction extends Action2 {
	constructor() {
		super({
			id: POP_OUT_VIEW_COMMAND_ID,
			title: localize2('triage.popOut', "Open in a Separate Window"),
			category: TRIAGE_CATEGORY,
			icon: Codicon.window,
			menu: {
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.equals(ActiveEditorContext.key, TriageViewEditor.ID),
			},
		});
	}

	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(MOVE_EDITOR_INTO_NEW_WINDOW_COMMAND_ID);
	}
}
