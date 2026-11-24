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
    expect(project?.domains[1]?.files).toEqual([
      { path: 'electronics/smart-fan.kicad_pro', exists: false },
    ]);
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
