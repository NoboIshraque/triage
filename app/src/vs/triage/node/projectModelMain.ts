/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The model service (ROADMAP P0-5, PLAN §4.2): a utility process that loads the
 *  Rust project model (triage_model.node, napi) and answers the window over a
 *  MessagePort. Patch 0002 adds this module to the build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'module';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { IProjectModelChannel, ITriageProject, PROJECT_MODEL_CHANNEL } from '../common/projectModel.js';

interface TriageModelAddon {
	loadProject(dir: string): ITriageProject | null;
}

class ProjectModelService implements IProjectModelChannel {
	private addon: TriageModelAddon | undefined;

	async loadProject(addonPath: string, folder: string): Promise<ITriageProject | null> {
		if (!this.addon) {
			this.addon = createRequire(import.meta.url)(addonPath) as TriageModelAddon;
		}
		return this.addon.loadProject(folder);
	}
}

if (!isUtilityProcess(process)) {
	throw new Error('projectModelMain must run in a utility process');
}

const server = new UtilityProcessServer();
server.registerChannel(PROJECT_MODEL_CHANNEL, ProxyChannel.fromService(new ProjectModelService(), new DisposableStore()));
