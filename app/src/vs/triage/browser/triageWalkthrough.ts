/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  "Get Started with Triage" on the Welcome page.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { FileAccess } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../workbench/common/contributions.js';
import { IWalkthroughsService } from '../../workbench/contrib/welcomeGettingStarted/browser/gettingStartedService.js';
import { ENGINEERING_LAYOUT_COMMAND_ID, TRIAGE_WALKTHROUGH_ID } from '../common/triage.js';

function markdownMedia(name: string): { type: 'markdown'; path: URI; base: URI; root: URI } {
	const root = FileAccess.asFileUri('vs/triage/browser/media/walkthrough/');
	return { type: 'markdown', path: FileAccess.asFileUri(`vs/triage/browser/media/walkthrough/${name}.md`), base: root, root };
}

export class TriageWalkthroughContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.triageWalkthrough';

	constructor(@IWalkthroughsService walkthroughsService: IWalkthroughsService) {
		const step = (id: string, order: number, title: string, description: string, completionEvents: string[]) => ({
			id: `${TRIAGE_WALKTHROUGH_ID}.${id}`,
			title,
			description,
			category: TRIAGE_WALKTHROUGH_ID,
			when: ContextKeyExpr.true(),
			order,
			completionEvents,
			media: markdownMedia(id),
		});

		walkthroughsService.registerWalkthrough({
			id: TRIAGE_WALKTHROUGH_ID,
			title: localize('triage.walkthrough.title', "Get Started with Triage"),
			description: localize('triage.walkthrough.description', "Code, circuits, 3D design and simulation of one device, in one window."),
			walkthroughPageTitle: localize('triage.walkthrough.pageTitle', "Triage"),
			order: 1000,
			source: localize('triage.walkthrough.source', "Triage"),
			isFeatured: true,
			when: ContextKeyExpr.true(),
			icon: { type: 'icon', icon: Codicon.circuitBoard },
			steps: [
				step('layout', 0,
					localize('triage.walkthrough.layout.title', "One window for the whole device"),
					localize('triage.walkthrough.layout.description', "Code sits beside the schematic, the board, the 3D model and the simulation, as tabs of one window.\n[Open Engineering Layout](command:{0})", ENGINEERING_LAYOUT_COMMAND_ID),
					[`onCommand:${ENGINEERING_LAYOUT_COMMAND_ID}`]),
				step('project', 1,
					localize('triage.walkthrough.project.title', "Open a project"),
					localize('triage.walkthrough.project.description', "A Triage project is a folder with a triage.toml next to its KiCad and FreeCAD files and its firmware.\n[Open Folder](command:workbench.action.files.openFolder)"),
					['onCommand:workbench.action.files.openFolder']),
				step('extensions', 2,
					localize('triage.walkthrough.extensions.title', "Bring your extensions"),
					localize('triage.walkthrough.extensions.description', "Themes, keymaps and language support install from Open VSX.\n[Browse Extensions](command:workbench.view.extensions)"),
					['onCommand:workbench.view.extensions']),
				step('roadmap', 3,
					localize('triage.walkthrough.roadmap.title', "What comes next"),
					localize('triage.walkthrough.roadmap.description', "Triage is being built in phases: circuits first, then 3D, then simulation on Arduino, ESP32 and Raspberry Pi."),
					[]),
			],
		});
	}
}
