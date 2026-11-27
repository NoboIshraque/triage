// Scenario tests, YAML v0 (ROADMAP P3-6): parsing, expressions, and the Smart
// Fan's scenarios. Those that run the firmware need avr-gcc (sketches.test.ts's
// rule: TRIAGE_REQUIRE_TOOLCHAIN=1 in CI's Sim workflow).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { addonAvailable } from '../src/addon.js';
import { buildProjectFirmware, findToolchain } from '../src/firmware.js';
import { loadProject } from '../src/project.js';
import {
  formatResult,
  loadScenario,
  parseExpression,
  parseScenario,
  quantity,
  runScenario,
} from '../src/scenario.js';
import { repoRoot } from './helpers.js';

const project = () => loadProject(path.join(repoRoot, 'examples', 'smart-fan'));
const dir = path.join(repoRoot, 'examples', 'smart-fan', 'simulation', 'scenarios');
const toolchain = !('missing' in findToolchain());
if (process.env['TRIAGE_REQUIRE_TOOLCHAIN'] === '1' && !toolchain)
  throw new Error('no AVR toolchain');

describe('scenario files', () => {
  it("parses PLAN §4.7's overheat scenario", () => {
    const s = loadScenario(path.join(dir, 'overheat.yaml'));
    expect(s.scope).toBe('whole-device');
    expect(s.duration).toBe(12);
    expect(s.temperatureProfile).toEqual([
      [0, 20],
      [10, 40],
    ]);
    expect(s.checks.map((c) => [c.kind, c.from, c.to])).toEqual([
      ['at', 8, 8],
      ['within', 9, 12],
      ['always', 0, 12],
    ]);
  });

  it('reads quantities and expressions', () => {
    expect(quantity('250ms')).toBeCloseTo(0.25);
    expect(quantity('1.5A')).toBe(1.5);
    expect(quantity('80%')).toBeCloseTo(0.8);
    expect(quantity('3.06V')).toBe(3.06);
    expect(parseExpression('pwm_duty(net: FAN_PWM) >= 0.8')).toMatchObject({
      op: '>=',
      right: 0.8,
    });
    expect(parseExpression('oled(J3).text contains "HOT"')).toMatchObject({
      op: 'contains',
      right: 'HOT',
    });
    expect(parseExpression('serial not contains "error"')).toMatchObject({ op: 'not contains' });
    expect(() => parseExpression('weather(today) > 3')).toThrow(/unknown function/);
    expect(() => parseScenario('name: x\nexpect: []\n')).toThrow(/expects nothing/);
  });

  it('every Smart Fan scenario parses', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const s = parseScenario(readFileSync(path.join(dir, f), 'utf8'), f);
      for (const c of s.checks) expect(() => parseExpression(c.that)).not.toThrow();
    }
  });
});

describe.skipIf(!addonAvailable())('Smart Fan scenarios without firmware', () => {
  for (const file of ['thermistor-divider.yaml', 'power-stage.yaml', 'rotor.yaml']) {
    it(file, () => {
      const result = runScenario(project(), loadScenario(path.join(dir, file)));
      console.log(formatResult(result));
      expect(result.passed).toBe(true);
    });
  }

  it('fails when an expectation fails, and says why', () => {
    const scenario = parseScenario(
      'name: too strict\nscope: circuit\nduration: 0.05s\nexpect:\n  - always: voltage(net: TEMP_SENSE) < 1V\n',
    );
    const result = runScenario(project(), scenario);
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/^2\.\d+ at 0\.005 s$/);
  });
});

describe.skipIf(!addonAvailable() || !toolchain)('Smart Fan scenarios with firmware', () => {
  for (const file of ['overheat.yaml', 'mode-button.yaml']) {
    it(file, () => {
      const p = project();
      const hex = readFileSync(buildProjectFirmware(p).hex, 'utf8');
      const result = runScenario(p, loadScenario(path.join(dir, file)), hex);
      console.log(formatResult(result));
      expect(result.passed).toBe(true);
    });
  }
});
