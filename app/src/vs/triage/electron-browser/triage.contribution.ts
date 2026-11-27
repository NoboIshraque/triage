/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Desktop-only parts of Triage (they need Electron's utility processes).
 *  Patch 0001 imports this from vs/workbench/workbench.desktop.main.ts.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { localize, localize2 } from '../../nls.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { TRIAGE_CATEGORY } from '../common/triage.js';
import { HELLO_ENGINE_COMMANDS, ITriageHelloEngineService } from '../common/helloEngine.js';
import { TriageHelloEngineService } from './helloEngineService.js';
import { ITriageProjectService } from '../common/projectModel.js';
import { TriageProjectService } from './projectService.js';
import { ITriageEdaEngineService } from '../common/eda/edaEngine.js';
import { TriageEdaEngineService } from './edaEngineService.js';
import { ITriageCadEngineService } from '../common/cad/cadEngineService.js';
import { TriageCadEngineService } from './cadEngineService.js';
import { ITriageSimService } from '../common/sim/simService.js';
import { TriageSimService } from './simEngineService.js';
import { TriageScenarioTesting } from './simTesting.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { TriagePinMapContribution } from './pinMapContribution.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { join } from '../../base/common/path.js';

registerSingleton(ITriageHelloEngineService, TriageHelloEngineService, InstantiationType.Delayed);
registerSingleton(ITriageProjectService, TriageProjectService, InstantiationType.Delayed);
registerSingleton(ITriageEdaEngineService, TriageEdaEngineService, InstantiationType.Delayed);
registerSingleton(ITriageCadEngineService, TriageCadEngineService, InstantiationType.Delayed);
registerSingleton(ITriageSimService, TriageSimService, InstantiationType.Delayed);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: HELLO_ENGINE_COMMANDS.start, title: localize2('triage.helloEngine.start', "Start Hello Engine"), category: TRIAGE_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ITriageHelloEngineService).start();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: HELLO_ENGINE_COMMANDS.benchmark, title: localize2('triage.helloEngine.benchmark', "Benchmark Hello Engine"), category: TRIAGE_CATEGORY, icon: Codicon.dashboard, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const engine = accessor.get(ITriageHelloEngineService);
		const notifications = accessor.get(INotificationService);
		const result = await engine.benchmark();
		notifications.info(localize('triage.helloEngine.benchmarkResult', "Hello engine: {0} MB/s into the window ({1} MB/s to the broker), {2} MiB in {3} KiB frames.", result.toWindow, result.toBroker, result.mebibytes, result.frameSize / 1024));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: HELLO_ENGINE_COMMANDS.kill, title: localize2('triage.helloEngine.kill', "Kill Hello Engine (Restart Test)"), category: TRIAGE_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ITriageHelloEngineService).kill();
	}
});

registerWorkbenchContribution2(TriagePinMapContribution.ID, TriagePinMapContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(TriageScenarioTesting.ID, TriageScenarioTesting, WorkbenchPhase.Eventually);

// Board build tasks (ROADMAP P1-5): the project's board profile names the board for
// arduino-cli or PlatformIO, run in a terminal.
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'triage.firmware.build', title: localize2('triage.firmware.build', "Build Firmware"), category: TRIAGE_CATEGORY, icon: Codicon.gear, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const projectService = accessor.get(ITriageProjectService);
		// Through the terminal's commands: importing its service pulls most of the
		// workbench into Triage's typecheck.
		const commands = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const state = projectService.state;
		if (state.kind !== 'project') {
			notifications.info(localize('triage.firmware.noProject', "Open a Triage project first."));
			return;
		}
		const code = state.project.domains.find(domain => domain.id === 'code');
		const board = BOARD_BUILDS[state.project.board ?? ''];
		if (!code || !board) {
			notifications.info(localize('triage.firmware.noBoard', "triage.toml names no board Triage can build for (firmware.board: arduino-uno or arduino-nano)."));
			return;
		}
		const folder = join(state.project.root, code.path);
		const platformio = (code.detail ?? '').includes('PlatformIO');
		const command = platformio
			? `pio run -d "${folder}" -e ${board.platformio}`
			: `arduino-cli compile --fqbn ${board.fqbn} "${folder}"`;
		await commands.executeCommand('workbench.action.terminal.new');
		await commands.executeCommand('workbench.action.terminal.sendSequence', { text: `${command}\r` });
	}
});

/** The board profiles of crates/triage-model/src/pinmap.rs, for the build command. */
const BOARD_BUILDS: Record<string, { fqbn: string; platformio: string }> = {
	'arduino-uno': { fqbn: 'arduino:avr:uno', platformio: 'uno' },
	'arduino-nano': { fqbn: 'arduino:avr:nano', platformio: 'nanoatmega328' },
};
