/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Loads the open folder's triage.toml through the model service (ROADMAP P0-5).
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { join } from '../../base/common/path.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { INativeWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { IProjectModelChannel, ITriageProjectService, PROJECT_MODEL_ADDON, PROJECT_MODEL_CHANNEL, PROJECT_MODEL_MODULE, TriageProjectState } from '../common/projectModel.js';

export class TriageProjectService extends Disposable implements ITriageProjectService {
	declare readonly _serviceBrand: undefined;

	private _state: TriageProjectState = { kind: 'none' };
	private readonly _onDidChangeState = this._register(new Emitter<TriageProjectState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private channel: IProjectModelChannel | undefined;
	private readonly worker = this._register(new MutableDisposable());
	private generation = 0;

	constructor(
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IUtilityProcessWorkerWorkbenchService private readonly workerService: IUtilityProcessWorkerWorkbenchService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
	) {
		super();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.refresh()));
	}

	get state(): TriageProjectState {
		return this._state;
	}

	async refresh(): Promise<void> {
		const generation = ++this.generation;
		const folder = this.workspaceService.getWorkspace().folders[0]?.uri;
		if (!folder || folder.scheme !== Schemas.file) {
			this.setState({ kind: 'none' });
			return;
		}
		this.setState({ kind: 'loading' });
		try {
			const channel = await this.getChannel();
			const addon = join(this.environmentService.appRoot, 'engines', PROJECT_MODEL_ADDON);
			const project = await channel.loadProject(addon, folder.fsPath);
			if (generation === this.generation) {
				this.setState(project ? { kind: 'project', project } : { kind: 'none' });
			}
		} catch (error) {
			if (generation === this.generation) {
				this.setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private async getChannel(): Promise<IProjectModelChannel> {
		if (!this.channel) {
			const worker = await this.workerService.createWorker({
				moduleId: PROJECT_MODEL_MODULE,
				type: 'triageProjectModel',
				name: 'triage-project-model',
			});
			this.worker.value = worker;
			void worker.onDidTerminate.then(() => {
				if (this.worker.value === worker) {
					this.channel = undefined;
				}
			});
			this.channel = ProxyChannel.toService<IProjectModelChannel>(worker.client.getChannel(PROJECT_MODEL_CHANNEL));
		}
		return this.channel;
	}

	private setState(state: TriageProjectState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}
}
