// Compiled Arduino sketches on the AVR unit (ROADMAP P3-2 done-when: Blink and
// serial echo at ≥ 1× real time) and the Smart Fan's own firmware on the whole
// device (P3-3, P3-5). Needs avr-gcc and the Arduino AVR core (sim/src/firmware.ts);
// skipped where they're missing unless TRIAGE_REQUIRE_TOOLCHAIN=1 (CI's Sim workflow).
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { addonAvailable } from '../src/addon.js';
import { buildFirmware, buildProjectFirmware, findToolchain } from '../src/firmware.js';
import { deviceSpec, findScope, loadProject } from '../src/project.js';
import { Runner } from '../src/runner.js';
import { WHOLE, ledDevice, repoRoot, timed } from './helpers.js';

const toolchain = findToolchain();
const required = process.env['TRIAGE_REQUIRE_TOOLCHAIN'] === '1';
if (required && 'missing' in toolchain) throw new Error(toolchain.missing);
const ready = addonAvailable() && !('missing' in toolchain);
const out = path.join(repoRoot, 'build', 'sim', 'firmware');

function sketch(name: string): string {
  const dir = path.join(import.meta.dirname, 'firmware', name);
  mkdirSync(out, { recursive: true });
  const result = buildFirmware({
    sourceDir: dir,
    board: 'arduino-uno',
    outDir: path.join(out, name),
  });
  return readFileSync(result.hex, 'utf8');
}

/** Seconds simulated per second of wall time. */
function speed(runner: Runner, seconds: number): number {
  const started = performance.now();
  runner.runFor(seconds);
  return seconds / ((performance.now() - started) / 1000);
}

describe.skipIf(!ready)('compiled sketches', () => {
  it('Blink toggles D13 every 500 ms at ≥ 1× real time', () => {
    const runner = new Runner({
      device: ledDevice(330),
      scope: WHOLE,
      firmwareHex: sketch('blink'),
    });
    runner.runFor(0.2); // warm up
    const ratio = speed(runner, 3);
    // pinMode makes the pin a low output first; then high for 500 ms, low for 500 ms.
    const { t, v } = runner.trace('A1.D13.drive');
    const edges: [number, number][] = [];
    for (let i = 1; i < t.length; i++) if (v[i - 1] !== 2) edges.push([t[i] ?? 0, v[i] ?? 0]);
    expect(edges.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < edges.length; i++) {
      const gap = (edges[i]?.[0] ?? 0) - (edges[i - 1]?.[0] ?? 0);
      expect(Math.abs(gap - 0.5)).toBeLessThan(0.002);
      expect(edges[i]?.[1]).not.toBe(edges[i - 1]?.[1]);
    }
    console.log(`Blink: ${ratio.toFixed(1)}× real time`);
    if (timed) expect(ratio).toBeGreaterThanOrEqual(1);
  });

  it('serial echo answers at ≥ 1× real time', () => {
    const runner = new Runner({
      device: ledDevice(),
      scope: WHOLE,
      firmwareHex: sketch('serial-echo'),
    });
    runner.runFor(0.05);
    expect(runner.serialText).toBe('echo ready\r\n');
    runner.avr?.sendSerial(Buffer.from('Smart Fan 123\n'));
    const ratio = speed(runner, 2);
    expect(runner.serialText).toBe('echo ready\r\nSmart Fan 123\n');
    console.log(`serial echo: ${ratio.toFixed(1)}× real time`);
    if (timed) expect(ratio).toBeGreaterThanOrEqual(1);
  });

  describe('the Smart Fan', () => {
    const project = loadProject(path.join(repoRoot, 'examples', 'smart-fan'));
    const hex = () => readFileSync(buildProjectFirmware(project).hex, 'utf8');

    it('runs the fan from the temperature, shows it on the OLED and spins the rotor', () => {
      const device = deviceSpec(project, { room_temperature_c: 35 });
      const runner = new Runner({
        device,
        scope: findScope('whole-device', project),
        firmwareHex: hex(),
      });
      const ratio = speed(runner, 3);
      // 35 °C: 80% duty on D9 (490 Hz PWM).
      const { t, v } = runner.trace('A1.D9.drive', 2);
      let high = 0;
      for (let i = 0; i < t.length; i++) {
        const end = t[i + 1] ?? 3;
        if (v[i] === 1) high += end - Math.max(t[i] ?? 0, 2);
      }
      expect(high).toBeGreaterThan(0.75);
      expect(high).toBeLessThan(0.85);
      const display = runner.displays.get('J3');
      expect(display?.text.split('\n')[0]).toMatch(/^35\.\dC 80%$/);
      expect(display?.text).toContain('AUTO');
      expect(display?.text).not.toContain('HOT');
      expect(runner.serialText).toContain('duty=80% mode=AUTO');
      expect(runner.value('J1.omega')).toBeGreaterThan(150);
      console.log(
        `Smart Fan, whole device: ${ratio.toFixed(1)}× real time; rotor ${((runner.value('J1.omega') * 60) / (2 * Math.PI)).toFixed(0)} rpm`,
      );
      if (timed) expect(ratio).toBeGreaterThanOrEqual(1);

      // Hotter: full speed and "HOT".
      runner.input('env.room_temperature_c', 40);
      runner.runFor(0.5);
      expect(display?.text).toContain('HOT');
      expect(display?.text.split('\n')[0]).toMatch(/100%$/);
      // The Mode button: Auto -> Max -> Off.
      runner.input('SW1.pressed', 1);
      runner.runFor(0.1);
      runner.input('SW1.pressed', 0);
      runner.runFor(0.1);
      runner.input('SW1.pressed', 1);
      runner.runFor(0.1);
      runner.input('SW1.pressed', 0);
      runner.runFor(0.3);
      expect(display?.text).toContain('OFF');
      runner.runFor(2);
      expect(runner.value('J1.omega')).toBeLessThan(30);
    });

    it('runs code only, with the virtual I/O panel standing in for the circuit', () => {
      const device = deviceSpec(project);
      const runner = new Runner({ device, scope: findScope('code', project), firmwareHex: hex() });
      expect(runner.info.left_out).toEqual(
        expect.arrayContaining(['circuit', 'mechanics', 'environment']),
      );
      // 3.03 V on A0 is 35 °C.
      runner.input('net:/TEMP_SENSE.value', 3.03);
      runner.runFor(1);
      expect(runner.displays.get('J3')?.text.split('\n')[0]).toMatch(/^3[45]\.\dC 8\d%$/);
    });
  });
});
