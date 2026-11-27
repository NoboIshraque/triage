// The Smart Fan as a device description: what the Rust kernel's tests use
// (crates/triage-sim/tests/fixtures) is what the project's files give.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deviceSpec,
  findScope,
  inferPart,
  loadProject,
  parseValue,
  scopes,
} from '../src/project.js';
import { repoRoot, smartFanDevice } from './helpers.js';

describe('project', () => {
  const project = loadProject(path.join(repoRoot, 'examples', 'smart-fan'));

  it('gives the Smart Fan the device the kernel tests use', () => {
    expect(deviceSpec(project)).toEqual(smartFanDevice());
  });

  it('reads component values', () => {
    expect(parseValue('10k')).toBe(10_000);
    expect(parseValue('4k7')).toBeCloseTo(4_700);
    expect(parseValue('4.7k')).toBeCloseTo(4_700);
    expect(parseValue('220')).toBe(220);
    expect(parseValue('100n')).toBeCloseTo(1e-7);
    expect(parseValue('12V in')).toBe(12);
    expect(parseValue('Mode')).toBeUndefined();
  });

  it('infers models from symbols', () => {
    const c = (symbol: string, value: string, pins: [string, string][]) =>
      inferPart({
        reference: 'X1',
        symbol: `lib:${symbol}`,
        value,
        footprint: '',
        pins: pins.map(([number, net]) => ({ number, name: '', net })),
      });
    expect(
      c('LED', 'red', [
        ['1', 'K'],
        ['2', 'A'],
      ]),
    ).toEqual({ model: 'led', params: {}, pins: { cathode: 'K', anode: 'A' } });
    expect(
      c('Q_NMOS_GSD', '2N7000', [
        ['1', 'G'],
        ['2', 'S'],
        ['3', 'D'],
      ])?.pins,
    ).toEqual({ g: 'G', s: 'S', d: 'D' });
    expect(
      c('R_Potentiometer', '10k', [
        ['1', 'T'],
        ['2', 'W'],
        ['3', 'B'],
      ])?.model,
    ).toBe('pot');
    expect(c('Conn_01x02', 'Fan', [])).toBeUndefined();
  });

  it('finds scopes by their short names', () => {
    expect(scopes(project).map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'Whole device',
        'Circuit only',
        'Code only',
        'Mechanism only',
        'Power stage only',
      ]),
    );
    expect(findScope('whole-device', project).run).toContain('firmware');
    expect(findScope('code', project).run).toEqual(['firmware', 'parts']);
    expect(findScope('power-stage', project).stubs).toHaveProperty(['net:FAN_PWM']);
  });

  it("keeps the OLED driver's font and the simulation's the same", async () => {
    const { FONT_5X7 } = await import('../src/font.js');
    const c = readFileSync(path.join(repoRoot, 'examples/smart-fan/firmware/src/oled.cpp'), 'utf8');
    const rows = [...c.matchAll(/\{(0x[0-9a-f]{2}(?:, 0x[0-9a-f]{2}){4})\}/g)].map((m) =>
      (m[1] ?? '').split(', ').map((b) => parseInt(b, 16)),
    );
    expect(rows).toEqual(FONT_5X7.map((g) => [...g]));
  });
});
