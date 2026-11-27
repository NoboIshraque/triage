// Board profiles of the AVR unit (ROADMAP P3-2): Arduino Uno and Nano
// (ATmega328P at 16 MHz) and how their pin names map to the chip's ports.

export interface AvrPin {
  readonly port: 'B' | 'C' | 'D';
  readonly bit: number;
  /** ADC channel, for A0–A7. */
  readonly adc?: number;
  /** An ADC-only pin (the Nano's A6 and A7): no digital I/O. */
  readonly adcOnly?: boolean;
}

export interface BoardProfile {
  readonly id: string;
  readonly name: string;
  readonly mcu: 'atmega328p';
  readonly frequency: number;
  readonly flashBytes: number;
  readonly pins: Readonly<Record<string, AvrPin>>;
  /** Pins with PWM (`analogWrite`). */
  readonly pwm: readonly string[];
  /** The on-board LED's pin. */
  readonly led: string;
}

function atmega328Pins(extraAdc: boolean): Record<string, AvrPin> {
  const pins: Record<string, AvrPin> = {};
  for (let i = 0; i <= 7; i++) pins[`D${i}`] = { port: 'D', bit: i };
  for (let i = 8; i <= 13; i++) pins[`D${i}`] = { port: 'B', bit: i - 8 };
  for (let i = 0; i <= 5; i++) pins[`A${i}`] = { port: 'C', bit: i, adc: i };
  if (extraAdc) {
    pins['A6'] = { port: 'C', bit: 6, adc: 6, adcOnly: true };
    pins['A7'] = { port: 'C', bit: 7, adc: 7, adcOnly: true };
  }
  return pins;
}

export const BOARDS: Readonly<Record<string, BoardProfile>> = {
  'arduino-uno': {
    id: 'arduino-uno',
    name: 'Arduino Uno',
    mcu: 'atmega328p',
    frequency: 16_000_000,
    flashBytes: 32 * 1024,
    pins: atmega328Pins(false),
    pwm: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'],
    led: 'D13',
  },
  'arduino-nano': {
    id: 'arduino-nano',
    name: 'Arduino Nano',
    mcu: 'atmega328p',
    frequency: 16_000_000,
    flashBytes: 32 * 1024,
    pins: atmega328Pins(true),
    pwm: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'],
    led: 'D13',
  },
};

export function board(id: string): BoardProfile {
  const profile = BOARDS[id];
  if (!profile) throw new Error(`no AVR board profile "${id}" (${Object.keys(BOARDS).join(', ')})`);
  return profile;
}
