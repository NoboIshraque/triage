/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Arduino IDE built in (ROADMAP PA): the Arduino side bar (Library Manager,
 *  Boards Manager, Examples), the Serial Monitor panel, the Arduino output channel,
 *  its settings, and the commands (arduinoCommands.ts).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../workbench/common/views.js';
import { Extensions as OutputExtensions, IOutputChannelRegistry, IOutputService } from '../../../workbench/services/output/common/output.js';
import { ARDUINO_BOARDS_URLS_SETTING, ARDUINO_BOARDS_VIEW_ID, ARDUINO_EXAMPLES_VIEW_ID, ARDUINO_LIBRARIES_VIEW_ID, ARDUINO_VIEW_CONTAINER_ID, ITriageArduinoService, PROJECTS_FOLDER_SETTING, SERIAL_MONITOR_CONTAINER_ID, SERIAL_MONITOR_VIEW_ID } from '../../common/arduino/arduino.js';
import { registerArduinoCommands } from './arduinoCommands.js';
import { BoardsManagerView, ExamplesView, LibraryManagerView, SerialMonitorView } from './arduinoViews.js';

export const ARDUINO_OUTPUT_CHANNEL = 'triage.arduino';

// --- settings ---

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'triage.arduino',
	title: localize('triage.arduino.settings', "Triage: Arduino"),
	type: 'object',
	properties: {
		[ARDUINO_BOARDS_URLS_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			markdownDescription: localize('triage.arduino.urlsSetting', "Package index URLs for more boards in the Boards Manager (the Arduino IDE's \"Additional boards manager URLs\"), for example ESP32's `https://espressif.github.io/arduino-esp32/package_esp32_index.json`. The Boards Manager's **More URLs…** button edits this."),
		},
		[PROJECTS_FOLDER_SETTING]: {
			type: 'string',
			default: '',
			description: localize('triage.projectsFolderSetting', "Where File → New Project and File → Examples create projects. Empty: Documents/Triage in your home folder."),
		},
	},
});

// --- the Arduino side bar ---

const arduinoIcon = registerIcon('triage-arduino-icon', Codicon.circuitBoard, localize('triage.arduino.icon', "View icon of the Arduino view."));

const arduinoContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: ARDUINO_VIEW_CONTAINER_ID,
	title: localize2('triage.arduino.container', "Arduino"),
	icon: Codicon.library,
	order: 0,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ARDUINO_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: 'workbench.triage.arduino.views.state',
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: ARDUINO_LIBRARIES_VIEW_ID,
		name: localize2('triage.arduino.libraries', "Library Manager"),
		containerIcon: arduinoIcon,
		ctorDescriptor: new SyncDescriptor(LibraryManagerView),
		canToggleVisibility: true,
		canMoveView: true,
		order: 1,
	},
	{
		id: ARDUINO_BOARDS_VIEW_ID,
		name: localize2('triage.arduino.boards', "Boards Manager"),
		containerIcon: arduinoIcon,
		ctorDescriptor: new SyncDescriptor(BoardsManagerView),
		canToggleVisibility: true,
		canMoveView: true,
		order: 2,
	},
	{
		id: ARDUINO_EXAMPLES_VIEW_ID,
		name: localize2('triage.arduino.examples', "Examples"),
		containerIcon: arduinoIcon,
		ctorDescriptor: new SyncDescriptor(ExamplesView),
		canToggleVisibility: true,
		canMoveView: true,
		order: 3,
	},
], arduinoContainer);

// --- the Serial Monitor panel ---

const monitorContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: SERIAL_MONITOR_CONTAINER_ID,
	title: localize2('triage.arduino.serialMonitor', "Serial Monitor"),
	icon: Codicon.plug,
	order: 10,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SERIAL_MONITOR_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.triage.serialMonitor.state',
}, ViewContainerLocation.Panel);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: SERIAL_MONITOR_VIEW_ID,
	name: localize2('triage.arduino.serialMonitor', "Serial Monitor"),
	containerIcon: Codicon.plug,
	ctorDescriptor: new SyncDescriptor(SerialMonitorView),
	canToggleVisibility: false,
	canMoveView: true,
}], monitorContainer);

// --- the Arduino output channel: compiler output, avrdude's upload, downloads ---

Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({
	id: ARDUINO_OUTPUT_CHANNEL,
	label: localize('triage.arduino.output', "Arduino"),
	log: false,
});

class ArduinoOutputContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.triageArduinoOutput';

	constructor(
		@ITriageArduinoService arduino: ITriageArduinoService,
		@IOutputService outputService: IOutputService,
	) {
		super();
		this._register(arduino.onDidOutput(output => {
			if (output.task !== 'monitor' && output.text) {
				outputService.getChannel(ARDUINO_OUTPUT_CHANNEL)?.append(output.text);
			}
		}));
		this._register(arduino.onDidChangeTask(task => {
			// A failed build or upload shows its output.
			if (task.kind === 'error') {
				void outputService.showChannel(ARDUINO_OUTPUT_CHANNEL, true);
			}
		}));
	}
}

registerWorkbenchContribution2(ArduinoOutputContribution.ID, ArduinoOutputContribution, WorkbenchPhase.AfterRestored);

registerArduinoCommands();
