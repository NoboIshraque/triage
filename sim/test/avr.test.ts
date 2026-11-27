// The AVR unit with the Rust kernel (ROADMAP P3-2): pins drive the circuit, the
// ADC syncs on demand, the serial port echoes, all at least as fast as real time.
// Hand-assembled programs: no avr-gcc needed (compiled sketches: sketches.test.ts).
import { describe, expect, it } from 'vitest';
import { addonAvailable } from '../src/addon.js';
import { Runner } from '../src/runner.js';
import { USART_INIT, WHOLE, asm, ledDevice, smartFanDevice, timed } from './helpers.js';

const BLINK = `
  sbi 0x04, 5        ; DDRB: D13 (PB5) is an output
loop:
  sbi 0x05, 5        ; on
  rcall delay
  cbi 0x05, 5        ; off
  rcall delay
  rjmp loop
delay:               ; 20 x 256 x 256 x 3 cycles: about 0.25 s
  ldi r18, 20
d1:
  ldi r19, 0
d2:
  ldi r20, 0
d3:
  dec r20
  brne d3
  dec r19
  brne d2
  dec r18
  brne d1
  ret
`;

const ECHO = `${USART_INIT}
loop:
  lds r17, 0xC0      ; UCSR0A
  sbrs r17, 7        ; RXC0: a byte arrived
  rjmp loop
  lds r18, 0xC6      ; UDR0
wait:
  lds r17, 0xC0
  sbrs r17, 5        ; UDRE0: room to send
  rjmp wait
  sts 0xC6, r18
  rjmp loop
`;

/** Reads A0 forever and sends each result as two bytes (high, low). */
const ADC_DUMP = `${USART_INIT}
  ldi r16, 0x40      ; ADMUX: AVcc reference, channel 0
  sts 0x7C, r16
  ldi r16, 0x87      ; ADCSRA: enable, prescaler 128
  sts 0x7A, r16
loop:
  lds r16, 0x7A
  ori r16, 0x40      ; ADSC: start a conversion
  sts 0x7A, r16
busy:
  lds r16, 0x7A
  sbrc r16, 6
  rjmp busy
  lds r18, 0x78      ; ADCL first, then ADCH
  lds r19, 0x79
  mov r20, r19
  rcall send
  mov r20, r18
  rcall send
  rjmp loop
send:
  lds r17, 0xC0
  sbrs r17, 5
  rjmp send
  sts 0xC6, r20
  ret
`;

describe.skipIf(!addonAvailable())('AVR unit', () => {
  it('blinks an LED through the circuit, faster than real time', () => {
    const runner = new Runner({ device: ledDevice(330), scope: WHOLE, firmwareHex: asm(BLINK) });
    const started = performance.now();
    runner.runUntil(2);
    const wall = (performance.now() - started) / 1000;
    const { t, v } = runner.trace('A1.D13.drive');
    // Edges every ~0.252 s: 20·(256·(256·3+3)+3)+… cycles at 16 MHz.
    const edges = Array.from(t).slice(1);
    expect(edges.length).toBeGreaterThanOrEqual(7);
    const gaps = edges.slice(1).map((x, i) => x - (edges[i] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(0.24);
      expect(gap).toBeLessThan(0.27);
    }
    expect(Array.from(v).slice(1, 3)).toEqual([1, 0]);
    // The LED is lit while the pin is high.
    const brightness = runner.trace('D2.brightness');
    expect(Math.max(...brightness.v)).toBeGreaterThan(0.4);
    console.log(
      `blink: 2 s simulated in ${wall.toFixed(2)} s (${(2 / wall).toFixed(1)}× real time)`,
    );
    if (timed) expect(2 / wall).toBeGreaterThanOrEqual(1);
  });

  it('reaches targets that are not whole picoseconds or whole cycles', () => {
    const runner = new Runner({
      device: ledDevice(),
      scope: WHOLE,
      firmwareHex: asm('loop:\n  rjmp loop\n'),
    });
    // 0.0017 s is 1700000000.0000002 ps: the app's paced runs ask for such times.
    for (let t = 0.001; t < 0.01; t += 0.0007) {
      runner.runUntil(t);
      expect(runner.now).toBeCloseTo(t, 12);
    }
    // Targets 10 ps apart, less than a CPU cycle (62.5 ps at 16 MHz).
    const start = runner.now;
    for (let i = 1; i <= 20; i++) runner.runUntil(start + i * 10e-12);
    expect(Math.round((runner.now - start) * 1e12)).toBe(200);
  });

  it('echoes serial input', () => {
    const runner = new Runner({ device: ledDevice(), scope: WHOLE, firmwareHex: asm(ECHO) });
    runner.runUntil(0.01);
    runner.avr?.sendSerial(Buffer.from('hello, Triage\n'));
    const started = performance.now();
    runner.runUntil(1);
    const wall = (performance.now() - started) / 1000;
    expect(runner.serialText).toBe('hello, Triage\n');
    // 14 bytes at 115200 baud: back within about 1.3 ms of being sent.
    const last = runner.avr?.serial.at(-1)?.t ?? 0;
    expect(last / 1e12).toBeLessThan(0.013);
    console.log(
      `serial echo: 1 s simulated in ${wall.toFixed(2)} s (${(1 / wall).toFixed(1)}× real time)`,
    );
    if (timed) expect(1 / wall).toBeGreaterThanOrEqual(1);
  });

  it('reads the thermistor divider with the ADC, synced to the circuit', () => {
    const device = smartFanDevice();
    for (const [celsius, count] of [
      [25, 511],
      [35, 620],
    ] as const) {
      device.environment.room_temperature_c = celsius;
      const runner = new Runner({ device, scope: WHOLE, firmwareHex: asm(ADC_DUMP) });
      runner.runUntil(0.05);
      const bytes = runner.avr?.serial.map((s) => s.byte) ?? [];
      expect(bytes.length).toBeGreaterThan(10);
      const value = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
      // 2.5 V sits on the 511/512 boundary; the 1 GΩ input takes it just under.
      expect(Math.abs(value - count)).toBeLessThanOrEqual(1);
    }
  });

  it("lights the Smart Fan's status LED from D13", () => {
    const LED_ON_OFF = `
  sbi 0x04, 5        ; DDRB: D13 (PB5) is an output
  sbi 0x05, 5        ; on
  ldi r18, 0         ; about 0.05 s: 256 x 256 x 3 cycles x 4
  ldi r20, 4
w1:
  ldi r19, 0
w2:
  dec r18
  brne w2
  dec r19
  brne w2
  dec r20
  brne w1
  cbi 0x05, 5        ; off
done:
  rjmp done
`;
    const runner = new Runner({
      device: smartFanDevice(),
      scope: WHOLE,
      firmwareHex: asm(LED_ON_OFF),
    });
    expect(runner.info.leds).toEqual([['D2', 'D2.brightness']]);
    runner.runUntil(0.02);
    // D13 drives about 5 V into 330 Ω and the LED: about 9 mA, close to half
    // its rated 20 mA (brightness is current over the rated current).
    expect(runner.value('net:/STATUS_LED')).toBeGreaterThan(4.5);
    expect(runner.value('D2.brightness')).toBeGreaterThan(0.35);
    runner.runUntil(0.2);
    expect(runner.value('D2.brightness')).toBeLessThan(0.01);
  });

  it('sees a slider move on the next conversion (code-only scope)', () => {
    const device = smartFanDevice();
    const scope = { name: 'Code only', run: ['firmware', 'parts'], stubs: {} };
    const runner = new Runner({ device, scope, firmwareHex: asm(ADC_DUMP) });
    expect(runner.info.left_out).toContain('circuit');
    expect(runner.info.io_panel.map((e) => e.label)).toEqual([
      'BUTTON (D2)',
      'FAN_PWM (D9)',
      'STATUS_LED (D13)',
      'TEMP_SENSE (A0)',
    ]);
    runner.runUntil(0.01);
    runner.input('net:/TEMP_SENSE.value', 1.25);
    runner.runUntil(0.03);
    const bytes = runner.avr?.serial.map((s) => s.byte) ?? [];
    const last = ((bytes.at(-2) ?? 0) << 8) | (bytes.at(-1) ?? 0);
    expect(last).toBe(256);
  });
});
