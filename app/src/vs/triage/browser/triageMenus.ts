/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Buttons and mouse first (ROADMAP PA-1, PLAN D13): every Triage command is in the
 *  Triage menu of the menu bar, and the everyday ones also have buttons where the
 *  work happens: Build, Upload and the Serial Monitor above code files, File → New
 *  Project and File → Examples. scripts/checks/buttons.test.mjs fails when a
 *  user-facing command is in none of these menus (or has no button of its own).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize } from '../../nls.js';
import { IMenuItem, ISubmenuItem, MenuId, MenuRegistry } from '../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { ARDUINO_COMMANDS } from '../common/arduino/arduino.js';
import { HELLO_ENGINE_COMMANDS } from '../common/helloEngine.js';
import { ENGINEERING_LAYOUT_COMMAND_ID, ENGINEERING_WINDOWS_COMMAND_ID } from '../common/triage.js';
import { CAD_COMMANDS } from './cad/cadCommands.js';
import { EDA_COMMANDS } from './eda/edaCommands.js';
import { SIM_COMMANDS } from './sim/simCommands.js';

export const TriageMenu = new MenuId('TriageMenubar');
const TriageElectronicsMenu = new MenuId('TriageMenubarElectronics');
const Triage3dMenu = new MenuId('TriageMenubar3d');
const TriageSimulationMenu = new MenuId('TriageMenubarSimulation');
const TriageDiagnosticsMenu = new MenuId('TriageMenubarDiagnostics');

/** The Triage menu, by group: every command a user can run (the test reads this table). */
export const TRIAGE_MENU: readonly { readonly menu: 'triage' | 'electronics' | '3d' | 'simulation' | 'diagnostics'; readonly group: string; readonly id: string; readonly title: string }[] = [
	{ menu: 'triage', group: '1_project', id: ENGINEERING_LAYOUT_COMMAND_ID, title: localize({ key: 'triage.menu.layout', comment: ['&& denotes a mnemonic'] }, "Open &&Engineering Layout") },
	{ menu: 'triage', group: '1_project', id: ENGINEERING_WINDOWS_COMMAND_ID, title: localize('triage.menu.windows', "Open Views in Separate Windows") },
	{ menu: 'triage', group: '1_project', id: ARDUINO_COMMANDS.newProject, title: localize({ key: 'triage.menu.newProject', comment: ['&& denotes a mnemonic'] }, "&&New Project…") },
	{ menu: 'triage', group: '1_project', id: ARDUINO_COMMANDS.examples, title: localize({ key: 'triage.menu.examples', comment: ['&& denotes a mnemonic'] }, "E&&xamples…") },
	{ menu: 'triage', group: '2_firmware', id: ARDUINO_COMMANDS.build, title: localize({ key: 'triage.menu.build', comment: ['&& denotes a mnemonic'] }, "&&Build Firmware") },
	{ menu: 'triage', group: '2_firmware', id: ARDUINO_COMMANDS.upload, title: localize({ key: 'triage.menu.upload', comment: ['&& denotes a mnemonic'] }, "&&Upload to the Board") },
	{ menu: 'triage', group: '2_firmware', id: ARDUINO_COMMANDS.serialMonitor, title: localize({ key: 'triage.menu.serialMonitor', comment: ['&& denotes a mnemonic'] }, "&&Serial Monitor") },
	{ menu: 'triage', group: '2_firmware', id: ARDUINO_COMMANDS.selectBoard, title: localize('triage.menu.selectBoard', "Select Board and Port…") },
	{ menu: 'triage', group: '3_managers', id: ARDUINO_COMMANDS.libraryManager, title: localize({ key: 'triage.menu.libraries', comment: ['&& denotes a mnemonic'] }, "&&Library Manager") },
	{ menu: 'triage', group: '3_managers', id: ARDUINO_COMMANDS.boardsManager, title: localize('triage.menu.boards', "Boards Manager") },
	{ menu: 'triage', group: '3_managers', id: ARDUINO_COMMANDS.boardsUrls, title: localize('triage.menu.boardsUrls', "Additional Boards Manager URLs…") },
	{ menu: 'electronics', group: '1_edit', id: EDA_COMMANDS.renameNet, title: localize('triage.menu.renameNet', "Rename Net…") },
	{ menu: 'electronics', group: '1_edit', id: EDA_COMMANDS.select, title: localize('triage.menu.selectPart', "Select Parts…") },
	{ menu: 'electronics', group: '2_file', id: EDA_COMMANDS.save, title: localize('triage.menu.saveEda', "Save Schematic and Board") },
	{ menu: 'electronics', group: '2_file', id: EDA_COMMANDS.reload, title: localize('triage.menu.reloadEda', "Reload from Disk") },
	{ menu: 'electronics', group: '3_fallback', id: EDA_COMMANDS.openInKicad, title: localize('triage.menu.openInKicad', "Edit in KiCad (Fallback Window)") },
	{ menu: '3d', group: '1_edit', id: CAD_COMMANDS.setPartHeight, title: localize('triage.menu.partHeight', "Set a Part's Height…") },
	{ menu: '3d', group: '1_edit', id: CAD_COMMANDS.check, title: localize('triage.menu.checkFit', "Check Fit and Clearance") },
	{ menu: '3d', group: '2_export', id: CAD_COMMANDS.exportEnclosure, title: localize('triage.menu.exportStl', "Export the Enclosure (STL)") },
	{ menu: 'simulation', group: '1_view', id: SIM_COMMANDS.focus, title: localize('triage.menu.simTab', "Show the Sim Tab") },
	{ menu: 'simulation', group: '2_run', id: SIM_COMMANDS.run, title: localize('triage.menu.run', "Run") },
	{ menu: 'simulation', group: '2_run', id: SIM_COMMANDS.pause, title: localize('triage.menu.pause', "Pause") },
	{ menu: 'simulation', group: '2_run', id: SIM_COMMANDS.step, title: localize('triage.menu.step', "Step 10 ms") },
	{ menu: 'simulation', group: '2_run', id: SIM_COMMANDS.stop, title: localize('triage.menu.stop', "Stop") },
	{ menu: 'simulation', group: '3_test', id: SIM_COMMANDS.scenarios, title: localize('triage.menu.scenarios', "Run the Scenarios") },
	{ menu: 'diagnostics', group: '1_benchmark', id: EDA_COMMANDS.benchmark, title: localize('triage.menu.benchmarkEda', "Benchmark Schematic and Board Views") },
	{ menu: 'diagnostics', group: '1_benchmark', id: CAD_COMMANDS.benchmark, title: localize('triage.menu.benchmarkCad', "Benchmark the 3D View") },
	{ menu: 'diagnostics', group: '1_benchmark', id: HELLO_ENGINE_COMMANDS.benchmark, title: localize('triage.menu.benchmarkHello', "Benchmark Hello Engine") },
	{ menu: 'diagnostics', group: '2_engines', id: HELLO_ENGINE_COMMANDS.start, title: localize('triage.menu.startHello', "Start Hello Engine") },
	{ menu: 'diagnostics', group: '2_engines', id: HELLO_ENGINE_COMMANDS.kill, title: localize('triage.menu.killHello', "Kill Hello Engine (Restart Test)") },
	{ menu: 'diagnostics', group: '2_engines', id: EDA_COMMANDS.restartEngine, title: localize('triage.menu.killKicad', "Kill the KiCad Engine (Restart Test)") },
];

const MENUS = {
	triage: TriageMenu,
	electronics: TriageElectronicsMenu,
	'3d': Triage3dMenu,
	simulation: TriageSimulationMenu,
	diagnostics: TriageDiagnosticsMenu,
} as const;

/** Source files of firmware: Build, Upload and the Serial Monitor above them (like the Arduino IDE's ✓ and →). */
const FIRMWARE_FILE = ContextKeyExpr.regex('resourceExtname', /^\.(ino|cpp|cc|cxx|c|h|hpp|S)$/);

export function registerTriageMenus(): void {
	MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
		submenu: TriageMenu,
		title: { value: 'Triage', original: 'Triage', mnemonicTitle: localize({ key: 'triage.menu.main', comment: ['&& denotes a mnemonic'] }, "Tri&&age") },
		order: 6.5,
	} satisfies ISubmenuItem);
	const submenus: [MenuId, string, string][] = [
		[TriageElectronicsMenu, localize('triage.menu.electronics', "Electronics"), '4_domains'],
		[Triage3dMenu, localize('triage.menu.3d', "3D"), '4_domains'],
		[TriageSimulationMenu, localize('triage.menu.simulation', "Simulation"), '4_domains'],
		[TriageDiagnosticsMenu, localize('triage.menu.diagnostics', "Diagnostics"), '9_diagnostics'],
	];
	for (const [order, [submenu, title, group]] of submenus.entries()) {
		MenuRegistry.appendMenuItem(TriageMenu, { submenu, title, group, order } satisfies ISubmenuItem);
	}
	for (const [order, item] of TRIAGE_MENU.entries()) {
		MenuRegistry.appendMenuItem(MENUS[item.menu], { command: { id: item.id, title: item.title }, group: item.group, order } satisfies IMenuItem);
	}

	// File → New Project… and File → Examples…, as in the Arduino IDE.
	MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: { id: ARDUINO_COMMANDS.newProject, title: localize({ key: 'triage.menu.fileNewProject', comment: ['&& denotes a mnemonic'] }, "New Triage &&Project…") }, group: '1_new', order: 0 });
	MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: { id: ARDUINO_COMMANDS.examples, title: localize({ key: 'triage.menu.fileExamples', comment: ['&& denotes a mnemonic'] }, "&&Examples…") }, group: '1_new', order: 0.5 });

	// Build, Upload and the Serial Monitor above code files.
	const editorButtons: [string, string, number][] = [
		[ARDUINO_COMMANDS.build, localize('triage.menu.buildButton', "Build Firmware"), -30],
		[ARDUINO_COMMANDS.upload, localize('triage.menu.uploadButton', "Upload to the Board"), -29],
		[ARDUINO_COMMANDS.serialMonitor, localize('triage.menu.monitorButton', "Serial Monitor"), -28],
	];
	for (const [id, title, order] of editorButtons) {
		MenuRegistry.appendMenuItem(MenuId.EditorTitle, { command: { id, title, icon: iconFor(id) }, group: 'navigation', order, when: FIRMWARE_FILE });
	}
}

function iconFor(id: string): ThemeIcon {
	switch (id) {
		case ARDUINO_COMMANDS.build: return Codicon.check;
		case ARDUINO_COMMANDS.upload: return Codicon.arrowRight;
		default: return Codicon.plug;
	}
}
