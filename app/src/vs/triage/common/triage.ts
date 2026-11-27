/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Triage's own workbench code (ROADMAP P0-3). It lives outside upstream's folders
 *  so VS Code merges stay mechanical (GUIDELINES §6).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize, localize2 } from '../../nls.js';

export const TRIAGE_CATEGORY = localize2('triage.category', "Triage");
export const TRIAGE_VIEW_CONTAINER_ID = 'workbench.view.triage';
export const TRIAGE_OVERVIEW_VIEW_ID = 'workbench.triage.overview';
export const ENGINEERING_LAYOUT_COMMAND_ID = 'triage.layout.engineering';
export const ENGINEERING_WINDOWS_COMMAND_ID = 'triage.layout.engineeringWindows';
export const POP_OUT_VIEW_COMMAND_ID = 'triage.view.popOut';
/**
 * VS Code's "Move Editor into New Window" (editorCommands.ts). Named here rather than
 * imported: editorCommands.js pulls most of the editor into Triage's typecheck.
 */
export const MOVE_EDITOR_INTO_NEW_WINDOW_COMMAND_ID = 'workbench.action.moveEditorToNewWindow';
export const TRIAGE_WALKTHROUGH_ID = 'triage.gettingStarted';
export const TRIAGE_VIEW_SCHEME = 'triage-view';

/** The tabs of the Engineering layout (PLAN §4.8), in the order they are laid out. */
export const enum TriageViewKind {
	Code = 'code',
	Schematic = 'schematic',
	Board = 'board',
	ThreeD = '3d',
	Sim = 'sim',
}

export interface ITriageView {
	readonly kind: TriageViewKind;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** What the tab is for. */
	readonly summary: string;
	/** Which work package fills it in (ROADMAP). */
	readonly arrives: string;
}

export const ENGINEERING_VIEWS: readonly ITriageView[] = [
	{
		kind: TriageViewKind.Code,
		label: localize('triage.view.code', "Code"),
		icon: Codicon.code,
		summary: localize('triage.view.code.summary', "Firmware and scripts open in this group, beside the circuit and the 3D model."),
		arrives: localize('triage.view.code.arrives', "Open a file from firmware/: pins come from the schematic (generated/board_pins.h), with diagnostics and Triage: Build Firmware."),
	},
	{
		kind: TriageViewKind.Schematic,
		label: localize('triage.view.schematic', "Schematic"),
		icon: Codicon.typeHierarchy,
		summary: localize('triage.view.schematic.summary', "The circuit, drawn by KiCad's own engine inside this tab."),
		arrives: localize('triage.view.schematic.arrives', "Viewing arrives in P1-4, simple edits in P1-6, full editing in P5."),
	},
	{
		kind: TriageViewKind.Board,
		label: localize('triage.view.board', "Board"),
		icon: Codicon.circuitBoard,
		summary: localize('triage.view.board.summary', "The printed circuit board, with cross-probing to the schematic and the code."),
		arrives: localize('triage.view.board.arrives', "Viewing arrives in P1-4, simple tracks in P3, push-and-shove routing in P5."),
	},
	{
		kind: TriageViewKind.ThreeD,
		label: localize('triage.view.3d', "3D"),
		icon: Codicon.package,
		summary: localize('triage.view.3d.summary', "The board and its enclosure in 3D, with Blender-style navigation."),
		arrives: localize('triage.view.3d.arrives', "The 3D view arrives in P2-3, the enclosure from the board in P2-4."),
	},
	{
		kind: TriageViewKind.Sim,
		label: localize('triage.view.sim', "Sim"),
		icon: Codicon.play,
		summary: localize('triage.view.sim.summary', "Run the whole device, or just the circuit, the code or the mechanism."),
		arrives: localize('triage.view.sim.arrives', "Arduino Uno and Nano simulate now (P3); ESP32 and Raspberry Pi arrive in P4."),
	},
];

export function triageView(kind: string): ITriageView | undefined {
	return ENGINEERING_VIEWS.find(view => view.kind === kind);
}
