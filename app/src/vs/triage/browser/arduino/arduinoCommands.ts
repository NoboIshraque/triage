/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Arduino IDE's actions in Triage (ROADMAP PA): Build, Upload, the board and
 *  port picker, the Serial Monitor, the Library and Boards Managers, examples and
 *  new projects. Each has a button or a menu entry (triageMenus.ts, PA-1).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../platform/quickinput/common/quickInput.js';
import { IPathService } from '../../../workbench/services/path/common/pathService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { ARDUINO_BOARDS_URLS_SETTING, ARDUINO_BOARDS_VIEW_ID, ARDUINO_COMMANDS, ARDUINO_LIBRARIES_VIEW_ID, IArduinoExample, IArduinoPort, ITriageArduinoService, PROJECTS_FOLDER_SETTING, SERIAL_MONITOR_VIEW_ID } from '../../common/arduino/arduino.js';
import { TRIAGE_CATEGORY } from '../../common/triage.js';

/** The folder new projects go in: the setting, or Documents/Triage in the home folder. */
export async function projectsFolder(configurationService: IConfigurationService, pathService: IPathService): Promise<URI> {
	const setting = configurationService.getValue<string>(PROJECTS_FOLDER_SETTING);
	if (setting) {
		return URI.file(setting);
	}
	return joinPath(await pathService.userHome(), 'Documents', 'Triage');
}

/** Opens a project folder in a new Triage window (the current project stays open). */
export async function openProject(hostService: IHostService, folder: string): Promise<void> {
	await hostService.openWindow([{ folderUri: URI.file(folder) }], { forceNewWindow: true });
}

export interface IExampleServices {
	readonly arduino: ITriageArduinoService;
	readonly configurationService: IConfigurationService;
	readonly pathService: IPathService;
	readonly hostService: IHostService;
	readonly notifications: INotificationService;
}

export function exampleServices(accessor: ServicesAccessor): IExampleServices {
	return {
		arduino: accessor.get(ITriageArduinoService),
		configurationService: accessor.get(IConfigurationService),
		pathService: accessor.get(IPathService),
		hostService: accessor.get(IHostService),
		notifications: accessor.get(INotificationService),
	};
}

/** Copies an example into a new project and opens it (File → Examples, the Examples view). */
export async function openExample(services: IExampleServices, example: IArduinoExample): Promise<string | undefined> {
	try {
		const engine = await services.arduino.engine();
		const parent = await projectsFolder(services.configurationService, services.pathService);
		const root = await engine.createProject({ folder: parent.fsPath, name: example.name, fqbn: services.arduino.fqbn ?? 'arduino:avr:uno', example: example.path });
		await openProject(services.hostService, root);
		return root;
	} catch (error) {
		services.notifications.error(localize('triage.arduino.exampleFailed', "Couldn't open the example: {0}", error instanceof Error ? error.message : String(error)));
		return undefined;
	}
}

interface BoardItem extends IQuickPickItem { readonly fqbn: string; readonly boardName: string; readonly port?: IArduinoPort }
interface PortItem extends IQuickPickItem { readonly port: IArduinoPort | undefined }

export function registerArduinoCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.build, title: localize2('triage.arduino.buildCommand', "Build Firmware"), category: TRIAGE_CATEGORY, icon: Codicon.check, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<boolean> {
			return (await accessor.get(ITriageArduinoService).build()) !== undefined;
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.upload, title: localize2('triage.arduino.uploadCommand', "Upload to the Board"), category: TRIAGE_CATEGORY, icon: Codicon.arrowRight, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<boolean> {
			const arduino = accessor.get(ITriageArduinoService);
			if (!arduino.port) {
				// Pick the board and port first, as the IDE does.
				const quickInput = accessor.get(IQuickInputService);
				const picked = await pickPort(quickInput, arduino);
				if (!picked) {
					return false;
				}
			}
			return arduino.upload();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.serialMonitor, title: localize2('triage.arduino.serialMonitorCommand', "Serial Monitor (Real Board)"), category: TRIAGE_CATEGORY, icon: Codicon.plug, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IViewsService).openView(SERIAL_MONITOR_VIEW_ID, true);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.selectBoard, title: localize2('triage.arduino.selectBoardCommand', "Select Board and Port…"), category: TRIAGE_CATEGORY, icon: Codicon.circuitBoard, f1: true });
		}
		/** Optional arguments (tests): an FQBN and a port address. */
		async run(accessor: ServicesAccessor, fqbn?: string, address?: string): Promise<void> {
			const arduino = accessor.get(ITriageArduinoService);
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			if (fqbn) {
				await arduino.setBoard(fqbn, fqbn);
				if (address) {
					arduino.setPort({ address, label: address, protocol: 'serial', protocolLabel: 'Serial Port', boards: [] });
				}
				return;
			}
			try {
				const engine = await arduino.engine();
				const [boards, ports] = await Promise.all([engine.boards(), engine.ports()]);
				const items: (BoardItem | IQuickPickSeparator)[] = [];
				const detected = ports.flatMap(port => port.boards.map(board => ({ port, board })));
				if (detected.length > 0) {
					items.push({ type: 'separator', label: localize('triage.arduino.plugged', "Plugged in") });
					for (const { port, board } of detected) {
						items.push({ label: `$(plug) ${board.name}`, description: port.label, fqbn: board.fqbn, boardName: board.name, port });
					}
				}
				items.push({ type: 'separator', label: localize('triage.arduino.allBoards', "All boards (installed platforms)") });
				for (const board of boards) {
					items.push({
						label: board.name,
						description: board.simulated ? localize('triage.arduino.simulates', "$(play) Triage simulates it") : board.fqbn,
						detail: board.simulated ? board.fqbn : undefined,
						fqbn: board.fqbn,
						boardName: board.name,
					});
				}
				const picked = await quickInput.pick(items, {
					placeHolder: localize('triage.arduino.pickBoard', "Pick the board (more boards: Boards Manager)"),
					matchOnDescription: true,
				});
				if (!picked) {
					return;
				}
				// The board's menu options (the IDE's Tools menu): a Nano's Processor …
				let chosen = picked.fqbn;
				const options = await engine.boardOptions(picked.fqbn.split(':').slice(0, 3).join(':'));
				for (const option of options.filter(o => o.values.length > 1)) {
					const value = await quickInput.pick(option.values.map(v => ({ label: v.label, picked: v.selected, value: v.value, description: v.selected ? localize('triage.arduino.default', "default") : '' })), {
						placeHolder: localize('triage.arduino.pickOption', "{0} of the {1}", option.label, picked.boardName),
					});
					if (!value) {
						return;
					}
					if (!value.picked) {
						chosen += `${chosen.split(':').length > 3 ? ',' : ':'}${option.option}=${value.value}`;
					}
				}
				await arduino.setBoard(chosen, picked.boardName);
				if (picked.port) {
					arduino.setPort(picked.port);
				} else {
					await pickPort(quickInput, arduino);
				}
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.libraryManager, title: localize2('triage.arduino.libraryManagerCommand', "Library Manager"), category: TRIAGE_CATEGORY, icon: Codicon.library, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IViewsService).openView(ARDUINO_LIBRARIES_VIEW_ID, true);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.boardsManager, title: localize2('triage.arduino.boardsManagerCommand', "Boards Manager"), category: TRIAGE_CATEGORY, icon: Codicon.circuitBoard, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IViewsService).openView(ARDUINO_BOARDS_VIEW_ID, true);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.boardsUrls, title: localize2('triage.arduino.boardsUrlsCommand', "Additional Boards Manager URLs…"), category: TRIAGE_CATEGORY, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const configurationService = accessor.get(IConfigurationService);
			const quickInput = accessor.get(IQuickInputService);
			const current = configurationService.getValue<string[]>(ARDUINO_BOARDS_URLS_SETTING) ?? [];
			const value = await quickInput.input({
				prompt: localize('triage.arduino.urlsPrompt', "Package index URLs for more boards, separated by spaces (for example ESP32's: https://espressif.github.io/arduino-esp32/package_esp32_index.json)"),
				value: current.join(' '),
			});
			if (value === undefined) {
				return;
			}
			await configurationService.updateValue(ARDUINO_BOARDS_URLS_SETTING, value.split(/\s+/).filter(Boolean));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.examples, title: localize2('triage.arduino.examplesCommand', "Examples…"), category: TRIAGE_CATEGORY, icon: Codicon.book, f1: true });
		}
		/** Optional argument (tests): an example's name, `Blink` or `01.Basics/Blink`. */
		async run(accessor: ServicesAccessor, name?: string): Promise<string | undefined> {
			const services = exampleServices(accessor);
			const arduino = services.arduino;
			const quickInput = accessor.get(IQuickInputService);
			const engine = await arduino.engine();
			const examples = await engine.examples(arduino.fqbn);
			let example = name ? examples.find(e => e.name === name || `${e.group}/${e.name}` === name) : undefined;
			if (!example) {
				const items: (IQuickPickItem & { example?: IArduinoExample } | IQuickPickSeparator)[] = [];
				let group = '';
				for (const e of examples) {
					if (e.group !== group) {
						group = e.group;
						items.push({ type: 'separator', label: e.builtIn ? group : localize('triage.arduino.libraryExamples', "{0} (library)", group) });
					}
					items.push({ label: e.name, description: e.group, example: e });
				}
				const picked = await quickInput.pick(items, { placeHolder: localize('triage.arduino.pickExample', "Open an example as a new project"), matchOnDescription: true });
				example = picked && 'example' in picked ? picked.example : undefined;
			}
			if (!example) {
				return undefined;
			}
			return openExample(services, example);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ARDUINO_COMMANDS.newProject, title: localize2('triage.arduino.newProjectCommand', "New Project…"), category: TRIAGE_CATEGORY, icon: Codicon.newFolder, f1: true });
		}
		async run(accessor: ServicesAccessor): Promise<string | undefined> {
			const arduino = accessor.get(ITriageArduinoService);
			const quickInput = accessor.get(IQuickInputService);
			const configurationService = accessor.get(IConfigurationService);
			const pathService = accessor.get(IPathService);
			const hostService = accessor.get(IHostService);
			const notifications = accessor.get(INotificationService);
			try {
				const engine = await arduino.engine();
				const boards = await engine.boards();
				const board = await quickInput.pick(boards.map(b => ({
					label: b.name,
					description: b.simulated ? localize('triage.arduino.simulates', "$(play) Triage simulates it") : b.fqbn,
					fqbn: b.fqbn,
				})), { placeHolder: localize('triage.arduino.newBoard', "The board the project is for") });
				if (!board) {
					return undefined;
				}
				const name = await quickInput.input({ prompt: localize('triage.arduino.newName', "The project's name"), value: 'MySketch' });
				if (!name) {
					return undefined;
				}
				const parent = await projectsFolder(configurationService, pathService);
				const root = await engine.createProject({ folder: parent.fsPath, name, fqbn: board.fqbn });
				await openProject(hostService, root);
				return root;
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
				return undefined;
			}
		}
	});
}

/** The port picker: the ports boards are on now, a plugged-in board named. */
export async function pickPort(quickInput: IQuickInputService, arduino: ITriageArduinoService): Promise<boolean> {
	const items: PortItem[] = arduino.ports.map(port => ({
		label: `$(plug) ${port.label}`,
		description: port.boards.map(b => b.name).join(', ') || port.protocolLabel,
		port,
	}));
	items.push({ label: localize('triage.arduino.noPortItem', "No port: build only"), port: undefined });
	const picked = await quickInput.pick(items, {
		placeHolder: arduino.ports.length > 0
			? localize('triage.arduino.pickPort', "The port the board is on")
			: localize('triage.arduino.noPorts', "No board found: plug the Arduino in with its USB cable (this list updates by itself)"),
	});
	if (!picked) {
		return false;
	}
	arduino.setPort(picked.port);
	return picked.port !== undefined;
}
