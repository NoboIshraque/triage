// The simulation commands (ROADMAP P3-6) on the Smart Fan.
import { fileURLToPath } from 'node:url';
import { addonAvailable } from '@triage/sim';
import { describe, expect, it } from 'vitest';
import { run } from './main.js';

const project = fileURLToPath(new URL('../../examples/smart-fan', import.meta.url));
const scenario = `${project}/simulation/scenarios/thermistor-divider.yaml`;

describe('triage sim and test', () => {
  it('lists the scopes, saved ones included', () => {
    const result = run(['sim', 'scopes', project]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('power-stage\tPower stage only');
    expect(result.stdout).toContain('Code only');
  });

  it('says what is wrong with a project that has none', () => {
    const result = run(['test', fileURLToPath(new URL('.', import.meta.url))]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('triage.toml');
  });

  it.runIf(addonAvailable())('runs a scenario headless and passes', () => {
    const result = run(['test', project, '--scenario', scenario]);
    expect(result.stdout).toContain('PASS the thermistor divider at 35 °C');
    expect(result.exitCode).toBe(0);
  });

  it.runIf(addonAvailable())('runs the circuit alone for a while', () => {
    const result = run([
      'sim',
      'run',
      project,
      '--scope',
      'circuit',
      '--for',
      '200ms',
      '--set',
      'env.room_temperature_c=35',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/net:\/TEMP_SENSE = 3\.0\d/);
  });
});
