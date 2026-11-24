/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Triage sidebar: the project's domains and the way into the one-window layout.
 *  P0-5 turns the domain list into the project explorer.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { localize } from '../../nls.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../workbench/common/views.js';
import { describeEngineState, HELLO_ENGINE_COMMANDS, IHelloEngineBenchmark, ITriageHelloEngineService } from '../common/helloEngine.js';
import { ENGINEERING_LAYOUT_COMMAND_ID, TRIAGE_WALKTHROUGH_ID } from '../common/triage.js';

const DOMAINS = [
	{ name: localize('triage.domain.code', "Code"), detail: localize('triage.domain.code.detail', "firmware and scripts") },
	{ name: localize('triage.domain.electronics', "Electronics"), detail: localize('triage.domain.electronics.detail', "schematic and board (KiCad files)") },
	{ name: localize('triage.domain.mechanical', "Mechanical"), detail: localize('triage.domain.mechanical.detail', "enclosure and mechanism (FreeCAD files)") },
	{ name: localize('triage.domain.simulation', "Simulation"), detail: localize('triage.domain.simulation.detail', "scopes, scenarios and recordings") },
];

export class TriageOverviewView extends ViewPane {
	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@ITriageHelloEngineService private readonly helloEngine: ITriageHelloEngineService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.triage-overview'));

		append(root, $('p', undefined, localize('triage.overview.intro', "One project, one window: code, circuit, board, 3D and simulation side by side.")));

		append(root, $('h3', undefined, localize('triage.overview.domains', "Project")));
		const list = append(root, $('ul.triage-domains'));
		for (const domain of DOMAINS) {
			append(list, $('li', undefined, $('strong', undefined, domain.name), ` ${domain.detail}`));
		}
		append(root, $('p.triage-note', undefined, localize('triage.overview.project', "Open a folder with a triage.toml to see its parts here (arrives in P0-5).")));

		const layout = this._register(new Button(root, { ...defaultButtonStyles, title: true }));
		layout.label = localize('triage.overview.layout', "Open Engineering Layout");
		this._register(layout.onDidClick(() => this.commandService.executeCommand(ENGINEERING_LAYOUT_COMMAND_ID)));

		const walkthrough = this._register(new Button(root, { ...defaultButtonStyles, secondary: true, title: true }));
		walkthrough.label = localize('triage.overview.walkthrough', "Get Started with Triage");
		this._register(walkthrough.onDidClick(() => this.commandService.executeCommand('workbench.action.openWalkthrough', TRIAGE_WALKTHROUGH_ID, false)));

		// The hello engine (ROADMAP P0-4) starts when this view first shows.
		append(root, $('h3', undefined, localize('triage.overview.engines', "Engines")));
		const status = append(root, $('p.triage-engine-status'));
		const benchmark = append(root, $('p.triage-engine-benchmark'));
		const renderState = () => status.textContent = localize('triage.overview.helloEngine', "Hello engine: {0}", describeEngineState(this.helloEngine.state));
		const renderBenchmark = (result: IHelloEngineBenchmark | undefined) => benchmark.textContent = result
			? localize('triage.overview.benchmark', "Benchmark: {0} MB/s into the window, {1} MB/s to the broker ({2} MiB)", result.toWindow, result.toBroker, result.mebibytes)
			: '';
		renderState();
		renderBenchmark(this.helloEngine.lastBenchmark);
		this._register(this.helloEngine.onDidChangeState(renderState));
		this._register(this.helloEngine.onDidBenchmark(renderBenchmark));
		const run = this._register(new Button(root, { ...defaultButtonStyles, secondary: true, title: true }));
		run.label = localize('triage.overview.runBenchmark', "Benchmark Hello Engine");
		this._register(run.onDidClick(() => this.commandService.executeCommand(HELLO_ENGINE_COMMANDS.benchmark)));
		this.helloEngine.start().catch(() => { /* shown in the status line */ });
	}
}
