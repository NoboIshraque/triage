#!/usr/bin/env node
// Checks out the pinned Arduino AVR core (upstream.json) into engines/arduino-avr/upstream/,
// for machines whose avr-gcc comes without it (Ubuntu's gcc-avr; sim/src/firmware.ts).
//   node engines/arduino-avr/fetch.mjs
import { fetchUpstream } from '../../scripts/forks/fetch.mjs';
import { main } from '../../scripts/forks/lib.mjs';

main(() => fetchUpstream(import.meta.dirname));
