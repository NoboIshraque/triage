/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Entry point of Triage's workbench code. Patch 0001 imports it from
 *  vs/workbench/workbench.desktop.main.ts.
 *--------------------------------------------------------------------------------------------*/

import './media/triage.css';
import { Codicon } from '../../base/common/codicons.js';
import { localize, localize2 } from '../../nls.js';
import { registerAction2 } from '../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../platform/chat/common/chatSettings.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { registerIcon } from '../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../workbench/browser/editor.js';
import { ViewPaneContainer } from '../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../workbench/common/editor.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../workbench/common/views.js';
import { TRIAGE_CATEGORY, TRIAGE_OVERVIEW_VIEW_ID, TRIAGE_VIEW_CONTAINER_ID } from '../common/triage.js';
import { OpenEngineeringLayoutAction, OpenEngineeringWindowsAction, PopOutViewAction } from './engineeringLayout.js';
import { TriageOverviewView } from './triageOverviewView.js';
import { TriageViewEditor, TriageViewInput, TriageViewInputSerializer } from './triageViewEditor.js';
import { TriageWalkthroughContribution } from './triageWalkthrough.js';

// --- VS Code's built-in AI features ---

// Hidden by default, at the owner's request (2026-11-24): the Copilot chat panel,
// its Sign In button, status bar item and setup prompts. VS Code's own setting does
// the hiding, so a user can turn them back on in Settings (chat.disableAIFeatures).
// The secondary side bar held only the chat, so it starts closed.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		[ChatAIDisabledSettingId]: true,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
	},
	preventExperimentOverride: true,
}]);

// --- Sidebar ---

const triageViewIcon = registerIcon('triage-view-icon', Codicon.circuitBoard, localize('triageViewIcon', "View icon of the Triage view."));

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: TRIAGE_VIEW_CONTAINER_ID,
	title: TRIAGE_CATEGORY,
	icon: triageViewIcon,
	order: -1,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [TRIAGE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.triage.views.state',
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: TRIAGE_OVERVIEW_VIEW_ID,
	name: localize2('triage.overview', "Overview"),
	containerIcon: triageViewIcon,
	ctorDescriptor: new SyncDescriptor(TriageOverviewView),
	canToggleVisibility: false,
	canMoveView: true,
}], container);

// --- Engineering layout tabs ---

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(TriageViewEditor, TriageViewEditor.ID, localize('triage.viewEditor', "Triage View")),
	[new SyncDescriptor(TriageViewInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(TriageViewInput.ID, TriageViewInputSerializer);

registerAction2(OpenEngineeringLayoutAction);
registerAction2(OpenEngineeringWindowsAction);
registerAction2(PopOutViewAction);

// --- Welcome page ---

registerWorkbenchContribution2(TriageWalkthroughContribution.ID, TriageWalkthroughContribution, WorkbenchPhase.BlockRestore);
