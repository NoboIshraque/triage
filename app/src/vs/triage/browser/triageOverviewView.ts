/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Triage sidebar: the open project's four domains (ROADMAP P0-5), the way into
 *  the one-window layout (P0-3) and the engines' state (P0-4).
 *--------------------------------------------------------------------------------------------*/

import { $, append, reset } from '../../base/browser/dom.js';
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
import { ITriageDomain, ITriageProjectService, TriageProjectState } from '../common/projectModel.js';
import { ENGINEERING_LAYOUT_COMMAND_ID, ENGINEERING_WINDOWS_COMMAND_ID, TRIAGE_WALKTHROUGH_ID } from '../common/triage.js';
import { URI } from '../../base/common/uri.js';
import { joinPath } from '../../base/common/resources.js';

/** What each domain holds, for folders that are not Triage projects yet. */
const DOMAIN_HINTS: Record<ITriageDomain['id'], string> = {
	code: localize('triage.domain.code.detail', "firmware and scripts"),
	electronics: localize('triage.domain.electronics.detail', "schematic and board (KiCad files)"),
	mechanical: localize('triage.domain.mechanical.detail', "enclosure and mechanism (FreeCAD files)"),
	simulation: localize('triage.domain.simulation.detail', "scopes, scenarios and recordings"),
};

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
		@ITriageProjectService private readonly projectService: ITriageProjectService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.triage-overview'));

		append(root, $('p', undefined, localize('triage.overview.intro', "One project, one window: code, circuit, board, 3D and simulation side by side.")));

		// The project explorer (ROADMAP P0-5): the four domains of the open project.
		const project = append(root, $('.triage-project'));
		const renderProject = (state: TriageProjectState) => this.renderProject(project, state);
		renderProject(this.projectService.state);
		this._register(this.projectService.onDidChangeState(renderProject));
		this.projectService.refresh();

		const layout = this._register(new Button(root, { ...defaultButtonStyles, title: true }));
		layout.label = localize('triage.overview.layout', "Open Engineering Layout");
		this._register(layout.onDidClick(() => this.commandService.executeCommand(ENGINEERING_LAYOUT_COMMAND_ID)));

		const windows = this._register(new Button(root, { ...defaultButtonStyles, secondary: true, title: true }));
		windows.label = localize('triage.overview.windows', "Open in Separate Windows");
		this._register(windows.onDidClick(() => this.commandService.executeCommand(ENGINEERING_WINDOWS_COMMAND_ID)));

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

	private renderProject(container: HTMLElement, state: TriageProjectState): void {
		if (state.kind !== 'project') {
			const note = state.kind === 'loading'
				? localize('triage.overview.loading', "Reading triage.toml…")
				: state.kind === 'error'
					? localize('triage.overview.error', "triage.toml has a problem: {0}", state.message)
					: localize('triage.overview.noProject', "Open a folder with a triage.toml to see its parts here.");
			reset(container,
				$('h3', undefined, localize('triage.overview.projectHeading', "Project")),
				$('ul.triage-domains', undefined, ...(['code', 'electronics', 'mechanical', 'simulation'] as const).map(id =>
					$('li', undefined, $('strong', undefined, labelOf(id)), ` ${DOMAIN_HINTS[id]}`))),
				$(state.kind === 'error' ? 'p.triage-note.triage-project-error' : 'p.triage-note', undefined, note),
			);
			return;
		}
		const { project } = state;
		const root = URI.file(project.root);
		const rows = project.domains.map(domain => {
			const row = $('li.triage-domain', { 'data-domain': domain.id, tabIndex: 0, role: 'button' },
				$('strong', undefined, domain.label),
				` ${domain.path}/`,
				domain.detail ? $('span.triage-note', undefined, ` · ${domain.detail}`) : '',
				!domain.configured ? $('span.triage-note', undefined, localize('triage.overview.notConfigured', " · not in triage.toml")) : '',
				domain.configured && !domain.exists ? $('span.triage-missing', undefined, localize('triage.overview.missing', " · folder missing")) : '',
				...domain.files.map(file => $('div.triage-file', undefined,
					`${file.path}`, file.exists ? '' : $('span.triage-note', undefined, localize('triage.overview.notYet', " (not created yet)")))),
			);
			row.title = localize('triage.overview.reveal', "Show {0} in the Explorer", domain.path);
			const reveal = () => this.commandService.executeCommand('revealInExplorer', joinPath(root, domain.path));
			row.addEventListener('click', reveal);
			row.addEventListener('keydown', event => { if (event.key === 'Enter') { reveal(); } });
			return row;
		});
		reset(container,
			$('h3.triage-project-name', undefined, project.name),
			project.description ? $('p.triage-note', undefined, project.description) : '',
			$('ul.triage-domains', undefined, ...rows),
		);
	}
}

function labelOf(id: ITriageDomain['id']): string {
	switch (id) {
		case 'code': return localize('triage.domain.code', "Code");
		case 'electronics': return localize('triage.domain.electronics', "Electronics");
		case 'mechanical': return localize('triage.domain.mechanical', "Mechanical");
		case 'simulation': return localize('triage.domain.simulation', "Simulation");
	}
}
