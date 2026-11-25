import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addon, repoRoot } from './addon.js';

describe.skipIf(addon === undefined)('triage_model.node', () => {
  // Only runs when the addon is built (skipIf above).
  const model = {
    get loadProject() {
      if (!addon) throw new Error('addon not built');
      return addon.loadProject.bind(addon);
    },
    manifestSchema: () => addon?.manifestSchema() ?? '',
    version: () => addon?.version() ?? '',
  };

  it('loads the Smart Fan example with its four domains', () => {
    const project = model.loadProject(path.join(repoRoot, 'examples', 'smart-fan'));
    expect(project?.name).toBe('Smart Fan');
    expect(project?.domains.map((d) => [d.id, d.label, d.path, d.exists])).toEqual([
      ['code', 'Code', 'firmware', true],
      ['electronics', 'Electronics', 'electronics', true],
      ['mechanical', 'Mechanical', 'mechanical', true],
      ['simulation', 'Simulation', 'simulation', true],
    ]);
    expect(project?.domains[0]?.detail).toBe('arduino-uno, arduino-cli');
    // The KiCad project arrived with ROADMAP P1.
    expect(project?.domains[1]?.files).toEqual([
      { path: 'electronics/smart-fan.kicad_pro', exists: true },
    ]);
    expect(project?.board).toBe('arduino-uno');
  });

  it('returns null for a folder without triage.toml', () => {
    expect(model.loadProject(path.join(repoRoot, 'crates'))).toBeNull();
  });

  it('throws with the line and column of a broken manifest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'triage-model-'));
    try {
      writeFileSync(path.join(dir, 'triage.toml'), '[project]\nname = "x"\nformat = = 0\n');
      expect(() => model.loadProject(dir)).toThrow(/triage\.toml:3:\d+:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes the JSON Schema and its version', () => {
    expect(JSON.parse(model.manifestSchema())).toHaveProperty('title');
    expect(model.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.skipIf(addon === undefined)('pin map (ROADMAP P1-5)', () => {
  const pinMap: NonNullable<typeof addon>['pinMap'] = (...args) => {
    if (!addon) throw new Error('addon not built');
    return addon.pinMap(...args);
  };

  it('writes board_pins.h and flags unconnected pins', () => {
    const result = pinMap(
      'arduino-uno',
      'electronics/smart-fan.kicad_sch',
      [
        {
          reference: 'A1',
          libId: 'smart_fan:Arduino_UNO_R3',
          footprint: 'smart_fan:Arduino_UNO_R3',
          pins: [{ number: '24', name: 'D9', net: '/FAN_PWM' }],
        },
        {
          reference: 'R2',
          libId: 'smart_fan:R',
          footprint: '',
          pins: [{ number: '1', name: '~', net: '/FAN_PWM' }],
        },
      ],
      [{ path: 'main.cpp', text: 'void loop() {\n  analogWrite(10, 128);\n}\n' }],
    );
    expect(result.header).toContain('constexpr uint8_t FAN_PWM =  9; // D9, PWM, net /FAN_PWM');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ line: 2, message: 'D10 is not connected to anything' }),
    ]);
  });

  it('throws for an unknown board', () => {
    expect(() => pinMap('esp32', 'x', [], [])).toThrow(/unknown board 'esp32'/);
  });
});
