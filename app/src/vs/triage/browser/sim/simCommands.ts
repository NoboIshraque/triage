/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Commands of the simulation (ROADMAP P3-5, P3-6): Run, Pause, Step, Stop, and
 *  the project's scenarios.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { ISimScenarioResult, ITriageSimService, SimState } from '../../common/sim/simService.js';
import { TRIAGE_CATEGORY, TriageViewKind, triageView } from '../../common/triage.js';
import { TriageViewEditor, TriageViewInput } from '../triageViewEditor.js';
import { SimView } from './simView.js';

export const SIM_COMMANDS = {
	focus: 'triage.sim.focus',
	run: 'triage.sim.run',
	pause: 'triage.sim.pause',
	step: 'triage.sim.step',
	stop: 'triage.sim.stop',
	scenarios: 'triage.sim.runScenarios',
} as const;

/** The Sim tab's view, opening the tab if needed. */
export async function simViewFor(editorService: IEditorService): Promise<SimView | undefined> {
	const visible = [editorService.activeEditorPane, ...editorService.visibleEditorPanes];
	for (const pane of visible) {
		if (pane instanceof TriageViewEditor && pane.sim) {
			return pane.sim;
		}
	}
	const view = triageView(TriageViewKind.Sim);
	if (!view) {
		return undefined;
	}
	const pane = await editorService.openEditor(new TriageViewInput(view), { preserveFocus: true });
	return pane instanceof TriageViewEditor ? pane.sim : undefined;
}

export function registerSimCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SIM_COMMANDS.focus, title: localize2('triage.sim.focusCommand', "Show the Sim Tab"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await simViewFor(accessor.get(IEditorService));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SIM_COMMANDS.run, title: localize2('triage.sim.runCommand', "Run the Simulation"), category: TRIAGE_CATEGORY, f1: true });
		}
		/** Optional arguments (tests): a scope ("Code only", "power-stage") and a speed (0: as fast as possible). */
		async run(accessor: ServicesAccessor, scope?: string, speed?: number): Promise<SimState> {
			const sim = accessor.get(ITriageSimService);
			const view = await simViewFor(accessor.get(IEditorService));
			if (!scope && sim.state.kind === 'paused') {
				await sim.run(speed ?? 1);
				return sim.state;
			}
			return view ? view.start(scope, speed) : sim.state;
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SIM_COMMANDS.pause, title: localize2('triage.sim.pauseCommand', "Pause the Simulation"), category: TRIAGE_CATEGORY, f1: true });
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ITriageSimService).pause();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SIM_COMMANDS.step, title: localize2('triage.sim.stepCommand', "Step the Simulation (10 ms)"), category: TRIAGE_CATEGORY, f1: true });
		}
		run(accessor: ServicesAccessor, seconds?: number): Promise<void> {
			return accessor.get(ITriageSimService).step(seconds ?? 0.01);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SIM_COMMANDS.stop, title: localize2('triage.sim.stopCommand', "Stop the Simulation"), category: TRIAGE_CATEGORY, f1: true });
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ITriageSimService).stop();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: SIM_COMMANDS.scenarios, title: localize2('triage.sim.scenariosCommand', "Run the Project's Scenarios"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor, files?: string[]): Promise<ISimScenarioResult[]> {
			const sim = accessor.get(ITriageSimService);
			const notifications = accessor.get(INotificationService);
			const view = await simViewFor(accessor.get(IEditorService));
			const { scenarios } = await sim.load();
			const chosen = files ?? [...scenarios];
			const results = view ? await view.runScenarios(chosen) : await sim.runScenarios(chosen);
			const failed = results.filter(r => !r.passed);
			notifications.notify({
				severity: failed.length === 0 ? Severity.Info : Severity.Warning,
				message: failed.length === 0
					? localize('triage.sim.scenariosPassed', "All {0} scenarios passed.", results.length)
					: localize('triage.sim.scenariosFailed', "{0} of {1} scenarios failed: {2}", failed.length, results.length, failed.map(r => r.name).join(', ')),
			});
			return results;
		}
	});
}
