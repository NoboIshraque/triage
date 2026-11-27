/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Arduino engine's utility process (ROADMAP PA): its own module, because VS Code
 *  keys a window's utility workers by module (one module, one process). Patch 0002
 *  adds this module to the build's entry points.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../base/common/lifecycle.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../base/parts/sandbox/node/electronTypes.js';
import { ARDUINO_ENGINE_CHANNEL } from '../common/arduino/arduino.js';
import { ArduinoEngine } from './arduinoEngine.js';

if (isUtilityProcess(process)) {
	const server = new UtilityProcessServer();
	server.registerChannel(ARDUINO_ENGINE_CHANNEL, ProxyChannel.fromService(new ArduinoEngine(), new DisposableStore()));
}
