/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Engineering layout: Code beside Schematic, Board, 3D and Sim, in one window.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { localize2 } from '../../nls.js';
import { Action2 } from '../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { EditorGroupLayout, GroupOrientation, GroupsOrder, IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { ENGINEERING_LAYOUT_COMMAND_ID, ENGINEERING_VIEWS, TRIAGE_CATEGORY } from '../common/triage.js';
import { TriageViewInput } from './triageViewEditor.js';

/**
 * Code on the left (40 %); on the right, Schematic and Board above 3D and Sim.
 * Leaf groups in grid order: Code, Schematic, Board, 3D, Sim.
 */
export const ENGINEERING_LAYOUT: EditorGroupLayout = {
	orientation: GroupOrientation.HORIZONTAL,
	groups: [
		{ size: 0.4 },
		{
			size: 0.6,
			groups: [
				{ size: 0.5, groups: [{ size: 0.5 }, { size: 0.5 }] },
				{ size: 0.5, groups: [{ size: 0.5 }, { size: 0.5 }] },
			],
		},
	],
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
		await Promise.all(ENGINEERING_VIEWS.map((view, index) => {
			const group = groups[Math.min(index, groups.length - 1)];
			return editorService.openEditor(new TriageViewInput(view), { pinned: true, preserveFocus: true }, group);
		}));
	}
}
