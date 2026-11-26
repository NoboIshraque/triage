// Test helpers: hand-assembled AVR programs (avr8js's assembler), so the AVR
// unit is tested on machines without avr-gcc; compiled sketches run where it is.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assemble } from 'avr8js/dist/esm/utils/assembler.js';
import { toHex } from '../src/hex.js';
import type { DeviceSpec } from '../src/project.js';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..');

export function asm(source: string): string {
  const { bytes, errors } = assemble(source);
  if (errors.length > 0) throw new Error(`assembler: ${errors.join('; ')}`);
  return toHex(bytes);
}

export function smartFanDevice(): DeviceSpec {
  return JSON.parse(
    readFileSync(
      path.join(repoRoot, 'crates/triage-sim/tests/fixtures/smart-fan.device.json'),
      'utf8',
    ),
  ) as DeviceSpec;
}

/** D13 → resistor → LED, the Uno's own blink circuit. */
export function ledDevice(ohms = 220): DeviceSpec {
  return {
    name: 'LED',
    ground: 'GND',
    board: {
      reference: 'A1',
      profile: 'arduino-uno',
      pins: [{ name: 'D13', net: 'LED_PIN', analog: false, pwm: false }],
      regulator: { net: '+5V', volts: 5 },
      vin: null,
      quiescent_a: 0.045,
    },
    parts: [
      { reference: 'R4', model: 'resistor', params: { ohms }, pins: { a: 'LED_PIN', b: 'LED_A' } },
      { reference: 'D2', model: 'led', params: {}, pins: { anode: 'LED_A', cathode: 'GND' } },
    ],
    environment: { room_temperature_c: 24, temperature_profile: [] },
    mechanics: [],
  };
}

export const WHOLE = {
  name: 'Whole device',
  run: ['firmware', 'circuit', 'mechanics', 'environment', 'parts'],
  stubs: {},
};

/** USART 115200 8N1 (UBRR 8 at 16 MHz), receiver and transmitter on. */
export const USART_INIT = `
  ldi r16, 8
  sts 0xC4, r16
  ldi r16, 0
  sts 0xC5, r16
  ldi r16, 0x18
  sts 0xC1, r16
  ldi r16, 0x06
  sts 0xC2, r16
`;
