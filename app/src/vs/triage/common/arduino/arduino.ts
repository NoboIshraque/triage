/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Arduino IDE built in (ROADMAP PA, ADR 0006): Build and Upload, the board and
 *  port picker, the Serial Monitor for a real board, the Library and Boards
 *  Managers and the examples. The window talks to the Arduino engine, a utility
 *  process that runs Triage's arduino-cli (sim/src/arduino.ts, engines/arduino).
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

export const ARDUINO_COMMANDS = {
	build: 'triage.arduino.build',
	upload: 'triage.arduino.upload',
	serialMonitor: 'triage.arduino.serialMonitor',
	selectBoard: 'triage.arduino.selectBoard',
	libraryManager: 'triage.arduino.libraryManager',
	boardsManager: 'triage.arduino.boardsManager',
	boardsUrls: 'triage.arduino.boardsUrls',
	examples: 'triage.arduino.examples',
	newProject: 'triage.arduino.newProject',
} as const;

export const ARDUINO_ENGINE_CHANNEL = 'triageArduinoEngine';
export const ARDUINO_VIEW_CONTAINER_ID = 'workbench.view.triageArduino';
export const ARDUINO_LIBRARIES_VIEW_ID = 'workbench.triage.arduino.libraries';
export const ARDUINO_BOARDS_VIEW_ID = 'workbench.triage.arduino.boards';
export const ARDUINO_EXAMPLES_VIEW_ID = 'workbench.triage.arduino.examples';
export const SERIAL_MONITOR_CONTAINER_ID = 'workbench.panel.triageSerialMonitor';
export const SERIAL_MONITOR_VIEW_ID = 'workbench.triage.serialMonitor';
/** The setting with extra Boards Manager index URLs (the Arduino IDE's "Additional boards manager URLs"). */
export const ARDUINO_BOARDS_URLS_SETTING = 'triage.arduino.additionalBoardsUrls';

/** A board the Arduino engine can build for. */
export interface IArduinoBoard {
	readonly name: string;
	/** arduino-cli's fully qualified board name, `arduino:avr:uno`. */
	readonly fqbn: string;
	/** The platform it belongs to, `arduino:avr`. */
	readonly platform: string;
	/** Triage's simulation board profile, when the simulator runs this board. */
	readonly simulated?: string;
}

/** A board's menu option (the IDE's Tools menu): Processor, CPU frequency … */
export interface IArduinoBoardOption {
	readonly option: string;
	readonly label: string;
	readonly values: readonly { readonly value: string; readonly label: string; readonly selected: boolean }[];
}

/** A port a board can be on (serial, network). */
export interface IArduinoPort {
	readonly address: string;
	readonly label: string;
	readonly protocol: string;
	readonly protocolLabel: string;
	/** Boards that answer on it (a genuine Uno is recognised by its USB IDs). */
	readonly boards: readonly { readonly name: string; readonly fqbn: string }[];
}

export interface IArduinoDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly severity: 'error' | 'warning' | 'note';
	readonly message: string;
}

export interface IArduinoBuild {
	readonly fqbn: string;
	readonly hex: string;
	readonly flash: number;
	readonly maxFlash: number;
	readonly ram: number;
	readonly maxRam: number;
	readonly libraries: readonly string[];
	readonly cached: boolean;
	readonly output: string;
	readonly diagnostics: readonly IArduinoDiagnostic[];
	readonly compileCommands?: string;
	readonly toolchain: string;
}

/** A library in the Library Manager. */
export interface IArduinoLibrary {
	readonly name: string;
	readonly author: string;
	readonly sentence: string;
	readonly paragraph: string;
	readonly website: string;
	readonly category: string;
	/** Versions available from the index, newest first. */
	readonly versions: readonly string[];
	/** The installed version, if any. */
	readonly installed?: string;
	/** Where it is installed. */
	readonly location?: string;
}

/** A platform in the Boards Manager. */
export interface IArduinoPlatform {
	/** `arduino:avr`, `esp32:esp32`. */
	readonly id: string;
	readonly name: string;
	readonly maintainer: string;
	readonly website: string;
	readonly versions: readonly string[];
	readonly installed?: string;
	readonly boards: readonly string[];
	/** Shipped inside Triage (the AVR boards): works offline. */
	readonly builtIn: boolean;
	/** Whether Triage simulates any of its boards. */
	readonly simulated: boolean;
}

/** An example sketch: the Arduino IDE's built-in examples, a library's. */
export interface IArduinoExample {
	readonly name: string;
	/** The sketch folder. */
	readonly path: string;
	/** "01.Basics", or the library's name. */
	readonly group: string;
	readonly builtIn: boolean;
}

/** Text from arduino-cli while it works: compiler output, avrdude's progress, downloads. */
export interface IArduinoOutput {
	readonly task: 'build' | 'upload' | 'install' | 'index' | 'monitor';
	readonly text: string;
}

export interface IArduinoProjectRef {
	readonly root: string;
	readonly firmwareDir: string;
	readonly board: string;
	readonly fqbn?: string;
}

/** The Arduino engine in its utility process (vs/triage/node/arduinoEngine). */
export interface IArduinoEngine {
	readonly onDidOutput: Event<IArduinoOutput>;
	readonly onDidChangePorts: Event<readonly IArduinoPort[]>;
	readonly onDidMonitor: Event<{ readonly text: string } | { readonly closed: string }>;

	/** Finds the engine in `folder` (resources/app/engines) and prepares the user's Arduino folder. */
	start(folder: string, additionalUrls: readonly string[]): Promise<{ arduinoCli: string; home: string; platform: string }>;
	setAdditionalUrls(urls: readonly string[]): Promise<void>;
	build(project: IArduinoProjectRef): Promise<IArduinoBuild>;
	upload(project: IArduinoProjectRef, port: string, protocol?: string): Promise<void>;
	boards(): Promise<IArduinoBoard[]>;
	boardOptions(fqbn: string): Promise<IArduinoBoardOption[]>;
	ports(): Promise<IArduinoPort[]>;
	/** Refreshes Arduino's package and library indexes (downloads them). */
	updateIndexes(): Promise<void>;
	searchLibraries(query: string): Promise<IArduinoLibrary[]>;
	installedLibraries(): Promise<IArduinoLibrary[]>;
	installLibrary(name: string, version?: string): Promise<void>;
	uninstallLibrary(name: string): Promise<void>;
	platforms(query: string): Promise<IArduinoPlatform[]>;
	installPlatform(id: string, version?: string): Promise<void>;
	uninstallPlatform(id: string): Promise<void>;
	examples(fqbn?: string): Promise<IArduinoExample[]>;
	/** Copies an example into a new Triage project folder (ROADMAP PA-6). */
	createProject(options: { folder: string; name: string; fqbn: string; example?: string }): Promise<string>;
	monitorOpen(port: string, baud: number, fqbn?: string): Promise<void>;
	monitorSend(text: string): Promise<void>;
	monitorClose(): Promise<void>;
}

export type ArduinoTask = { readonly kind: 'idle' } | { readonly kind: 'busy'; readonly what: string } | { readonly kind: 'error'; readonly message: string };

export const ITriageArduinoService = createDecorator<ITriageArduinoService>('triageArduinoService');

/** The window's side: the selected board and port, and the engine's operations. */
export interface ITriageArduinoService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSelection: Event<void>;
	readonly onDidChangePorts: Event<readonly IArduinoPort[]>;
	readonly onDidOutput: Event<IArduinoOutput>;
	readonly onDidMonitor: Event<{ readonly text: string } | { readonly closed: string }>;
	readonly onDidChangeTask: Event<ArduinoTask>;
	/** The board builds and uploads are for (the project's, or the picked one). */
	readonly fqbn: string | undefined;
	readonly boardName: string | undefined;
	readonly port: IArduinoPort | undefined;
	readonly ports: readonly IArduinoPort[];
	readonly task: ArduinoTask;
	engine(): Promise<IArduinoEngine>;
	setBoard(fqbn: string, name: string): Promise<void>;
	setPort(port: IArduinoPort | undefined): void;
	/** Builds the open project's firmware: problems, the Output panel, the status bar. */
	build(): Promise<IArduinoBuild | undefined>;
	upload(): Promise<boolean>;
}
