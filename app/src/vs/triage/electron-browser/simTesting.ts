/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Scenario tests in VS Code's Test Explorer (ROADMAP P3-6): a test controller,
 *  registered from the workbench, lists simulation/scenarios/*.yaml and runs
 *  them in the sim engine, each check's outcome as the test's message.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { observableValue } from '../../base/common/observable.js';
import { basename, join } from '../../base/common/path.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../workbench/common/contributions.js';
import { TestId } from '../../workbench/contrib/testing/common/testId.js';
import { ITestProfileService } from '../../workbench/contrib/testing/common/testProfileService.js';
import { LiveTestResult } from '../../workbench/contrib/testing/common/testResult.js';
import { ITestResultService } from '../../workbench/contrib/testing/common/testResultService.js';
import { IMainThreadTestController, ITestService } from '../../workbench/contrib/testing/common/testService.js';
import { IStartControllerTests, IStartControllerTestsResult, TestControllerCapability, TestDiffOpType, TestItemExpandState, TestMessageType, TestResultState, TestRunProfileBitset } from '../../workbench/contrib/testing/common/testTypes.js';
import { ITriageProjectService } from '../common/projectModel.js';
import { ITriageSimService } from '../common/sim/simService.js';

const CONTROLLER_ID = 'triage.scenarios';

export class TriageScenarioTesting extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.triageScenarioTesting';

	private readonly registration = this._register(new MutableDisposable());
	private files: readonly string[] = [];

	constructor(
		@ITestService private readonly testService: ITestService,
		@ITestProfileService private readonly profileService: ITestProfileService,
		@ITestResultService private readonly resultService: ITestResultService,
		@ITriageSimService private readonly sim: ITriageSimService,
		@ITriageProjectService private readonly projectService: ITriageProjectService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.projectService.onDidChangeState(() => void this.refresh()));
		void this.refresh();
	}

	/** Lists the scenario files (without starting the sim engine: it starts when a test runs). */
	private async refresh(): Promise<void> {
		const state = this.projectService.state;
		if (state.kind !== 'project') {
			this.registration.clear();
			return;
		}
		try {
			const simulation = state.project.domains.find(domain => domain.id === 'simulation')?.path || 'simulation';
			const dir = join(state.project.root, simulation, 'scenarios');
			const stat = await this.fileService.resolve(URI.file(dir)).catch(() => undefined);
			this.files = (stat?.children ?? []).filter(c => /\.ya?ml$/.test(c.name)).map(c => c.resource.fsPath).sort();
			this.registration.clear();
			this.register();
		} catch (error) {
			this.logService.trace('[triage] scenarios not listed in the Test Explorer', error);
		}
	}

	private register(): void {
		const controller: IMainThreadTestController = {
			id: CONTROLLER_ID,
			label: observableValue(`${CONTROLLER_ID}.label`, localize('triage.tests.label', "Triage scenarios")),
			capabilities: observableValue(`${CONTROLLER_ID}.capabilities`, TestControllerCapability.Refresh),
			syncTests: async () => { },
			refreshTests: async () => this.refresh(),
			configureRunProfile: () => { },
			expandTest: async () => { },
			getRelatedCode: async () => [],
			startContinuousRun: async () => [],
			runTests: (requests, token) => this.runTests(requests, token),
		};
		const store = this.testService.registerTestController(CONTROLLER_ID, controller);
		this.profileService.addProfile(controller, {
			controllerId: CONTROLLER_ID,
			profileId: 1,
			label: localize('triage.tests.run', "Run in the simulation"),
			group: TestRunProfileBitset.Run,
			isDefault: true,
			tag: null,
			hasConfigurationHandler: false,
			supportsContinuousRun: false,
		});
		const root = { extId: CONTROLLER_ID, label: localize('triage.tests.label', "Triage scenarios"), tags: [], busy: false, uri: undefined, range: null, description: null, error: null, sortText: null };
		this.testService.publishDiff(CONTROLLER_ID, [
			{ op: TestDiffOpType.Add, item: { controllerId: CONTROLLER_ID, expand: TestItemExpandState.Expanded, item: root } },
			...this.files.map(file => ({
				op: TestDiffOpType.Add as const,
				item: {
					controllerId: CONTROLLER_ID,
					expand: TestItemExpandState.NotExpandable,
					item: {
						extId: TestId.joinToString(CONTROLLER_ID, file),
						label: basename(file),
						tags: [],
						busy: false,
						uri: URI.file(file),
						range: null,
						description: null,
						error: null,
						sortText: null,
					},
				},
			})),
		]);
		this.registration.value = {
			dispose: () => {
				this.profileService.removeProfile(CONTROLLER_ID);
				store.dispose();
			},
		};
	}

	private async runTests(requests: IStartControllerTests[], token: CancellationToken): Promise<IStartControllerTestsResult[]> {
		const out: IStartControllerTestsResult[] = [];
		for (const request of requests) {
			const result = this.resultService.getResult(request.runId);
			if (!(result instanceof LiveTestResult)) {
				out.push({ error: 'no live result for the run' });
				continue;
			}
			const taskId = `${request.runId}-scenarios`;
			result.addTask({ id: taskId, name: localize('triage.tests.task', "Triage simulation"), running: true, ctrlId: CONTROLLER_ID });
			const ids = request.testIds.some(id => id === CONTROLLER_ID)
				? this.files.map(file => TestId.joinToString(CONTROLLER_ID, file))
				: request.testIds;
			for (const id of ids) {
				if (token.isCancellationRequested) {
					break;
				}
				const file = TestId.localId(id);
				result.updateState(id, taskId, TestResultState.Running);
				const [scenario] = await this.sim.runScenarios([file]);
				if (!scenario) {
					result.updateState(id, taskId, TestResultState.Errored);
					continue;
				}
				for (const check of scenario.checks) {
					if (!check.passed) {
						result.appendMessage(id, taskId, {
							type: TestMessageType.Error,
							message: `${check.kind}: ${check.that}: ${check.detail}`,
							expected: undefined,
							actual: undefined,
							contextValue: undefined,
							location: undefined,
							stackTrace: undefined,
						});
					}
				}
				if (scenario.error) {
					result.appendMessage(id, taskId, { type: TestMessageType.Error, message: scenario.error, expected: undefined, actual: undefined, contextValue: undefined, location: undefined, stackTrace: undefined });
				}
				result.updateState(id, taskId, scenario.error ? TestResultState.Errored : scenario.passed ? TestResultState.Passed : TestResultState.Failed, scenario.wall * 1000);
			}
			result.markTaskComplete(taskId);
			out.push({});
		}
		return out;
	}
}
