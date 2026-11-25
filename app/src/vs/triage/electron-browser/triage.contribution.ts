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

registerSingleton(ITriageHelloEngineService, TriageHelloEngineService, InstantiationType.Delayed);
registerSingleton(ITriageProjectService, TriageProjectService, InstantiationType.Delayed);
registerSingleton(ITriageEdaEngineService, TriageEdaEngineService, InstantiationType.Delayed);

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
