// The simulation commands (ROADMAP P3-6, PLAN §4.10): `triage test` runs a
// project's scenarios headless (the CI job, and the same runner as the app's Sim
// tab), `triage sim run` runs a scope for a while and prints what it saw,
// `triage build` builds the firmware.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildProjectFirmware,
  deviceSpec,
  findScope,
  formatResult,
  loadProject,
  loadScenario,
  Runner,
  runScenario,
  scopes,
  type ScenarioResult,
} from '@triage/sim';
import type { CliResult } from './main.js';

interface Parsed {
  readonly positional: string[];
  readonly options: Map<string, string[]>;
}

function parse(argv: readonly string[], flags: readonly string[]): Parsed {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = flags.includes(name) ? 'true' : (argv[++i] ?? '');
      options.set(name, [...(options.get(name) ?? []), value]);
    } else positional.push(arg);
  }
  return { positional, options };
}

function seconds(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value);
  if (!m) throw new Error(`not a duration: ${value}`);
  return Number(m[1]) * (m[2] === 'ms' ? 1e-3 : 1);
}

function firmwareFor(project: ReturnType<typeof loadProject>, lines: string[]): string {
  const result = buildProjectFirmware(project);
  lines.push(
    `firmware: ${path.relative(process.cwd(), result.hex) || result.hex} (${result.flash} bytes flash, ${result.ram} bytes RAM${result.cached ? ', up to date' : ''}; ${result.toolchain})`,
  );
  return readFileSync(result.hex, 'utf8');
}

/** `triage test [PROJECT] [--scenario FILE]… [--report FILE.json]` */
export function testCommand(argv: readonly string[]): CliResult {
  const { positional, options } = parse(argv, []);
  const project = loadProject(path.resolve(positional[0] ?? '.'));
  const dir = path.join(project.simulationDir, 'scenarios');
  const files =
    options.get('scenario')?.map((f) => path.resolve(f)) ??
    (existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /\.ya?ml$/.test(f))
          .sort()
          .map((f) => path.join(dir, f))
      : []);
  if (files.length === 0)
    return { exitCode: 1, stdout: '', stderr: `triage test: no scenarios in ${dir}\n` };
  const lines = [`Triage scenarios for ${project.name} (${files.length})`];
  const scenarios = files.map((f) => loadScenario(f));
  const needsFirmware = scenarios.some((s) => findScope(s.scope, project).run.includes('firmware'));
  const hex = needsFirmware ? firmwareFor(project, lines) : undefined;
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    let result: ScenarioResult;
    try {
      result = runScenario(project, scenario, hex);
    } catch (error) {
      result = {
        scenario,
        passed: false,
        checks: [],
        wall: 0,
        speed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    lines.push(formatResult(result));
  }
  const failed = results.filter((r) => !r.passed).length;
  lines.push(
    failed === 0
      ? `All ${results.length} scenarios passed.`
      : `${failed} of ${results.length} scenarios failed.`,
  );
  const report = options.get('report')?.[0];
  if (report) {
    writeFileSync(
      report,
      `${JSON.stringify(
        results.map((r) => ({
          name: r.scenario.name,
          file: path.relative(project.root, r.scenario.file),
          scope: r.scenario.scope,
          passed: r.passed,
          seconds: r.scenario.duration,
          wall: r.wall,
          speed: r.speed,
          error: r.error,
          checks: r.checks.map((c) => ({
            kind: c.check.kind,
            that: c.check.that,
            passed: c.passed,
            detail: c.detail,
          })),
        })),
        null,
        2,
      )}\n`,
    );
  }
  return { exitCode: failed === 0 ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/** `triage sim run [PROJECT] --scope NAME --for 5s [--set CONTROL=VALUE]… [--watch SIGNAL]…`, `triage sim scopes` */
export function simCommand(argv: readonly string[]): CliResult {
  const [sub, ...rest] = argv;
  const { positional, options } = parse(rest, []);
  const project = loadProject(path.resolve(positional[0] ?? '.'));
  if (sub === 'scopes') {
    const out = scopes(project).map(
      (s) =>
        `${s.id ?? s.name.toLowerCase().replace(/\s+/g, '-')}\t${s.name}\truns ${s.run.join(', ')}`,
    );
    return { exitCode: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
  }
  if (sub !== 'run')
    return { exitCode: 2, stdout: '', stderr: 'usage: triage sim run|scopes [PROJECT] …\n' };
  const scope = findScope(options.get('scope')?.[0] ?? 'whole-device', project);
  const duration = seconds(options.get('for')?.[0] ?? '5s');
  const lines = [`${project.name}: ${scope.name} for ${duration} s`];
  const firmwareHex = scope.run.includes('firmware') ? firmwareFor(project, lines) : undefined;
  const runner = new Runner({
    device: deviceSpec(project),
    scope,
    ...(firmwareHex ? { firmwareHex } : {}),
  });
  for (const set of options.get('set') ?? []) {
    const [control = '', value = ''] = set.split('=');
    runner.input(control, Number(value));
  }
  const started = performance.now();
  runner.runUntil(duration);
  const wall = (performance.now() - started) / 1000;
  lines.push(
    `simulated ${duration} s in ${wall.toFixed(2)} s (${(duration / wall).toFixed(1)}× real time)`,
  );
  if (runner.info.stubs.length > 0)
    lines.push(`stubs: ${runner.info.stubs.map((s) => `${s.signal} (${s.kind})`).join(', ')}`);
  const watch =
    options.get('watch') ??
    runner.info.signals
      .map(([n]) => n)
      .filter((n) => /^(net:|rail:|env:)|\.(omega|current)$/.test(n));
  for (const name of watch) lines.push(`  ${name} = ${Number(runner.value(name).toPrecision(5))}`);
  for (const [ref, display] of runner.displays)
    lines.push(`  ${ref} shows: ${display.text.replace(/\n/g, ' | ') || '(nothing)'}`);
  const serial = runner.serialText.trim().split(/\r?\n/).slice(-5);
  if (serial[0]) lines.push('serial (last lines):', ...serial.map((l) => `  ${l}`));
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/** `triage build [PROJECT]` */
export function buildCommand(argv: readonly string[]): CliResult {
  const project = loadProject(path.resolve(argv[0] ?? '.'));
  const lines: string[] = [];
  firmwareFor(project, lines);
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
