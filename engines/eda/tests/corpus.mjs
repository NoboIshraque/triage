// The kicad-demos corpus checks (ROADMAP P1-1, P1-2): KiCad's 36 demo projects,
// shipped in KiCad's source (upstream/demos/), through kicad-cli and the engine
// built from Triage's tree.
//
// For every root schematic: netlist export and ERC. For every board: DRC and an
// SVG export. Then triage-eda-engine --load-all opens every board and root
// schematic, builds its display list and netlist. The counts must match the
// golden file tests/golden/corpus.json on Windows and Linux alike
// (`node engines/eda/build.mjs test --update` rewrites it).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { stagedEnv, stagedProgram, stageDir } from '../stage.mjs';

/**
 * Rules-check violation counts may differ by a few between machines: boards that
 * use system fonts (tiny_tapeout: FreeMono, Liberation Mono) get different text
 * shapes, so different silkscreen results, where a font is missing (664 locally,
 * 665 on GitHub's Ubuntu runner, 2026-11-25). They get 1% (at least 1); every
 * other value must match exactly.
 */
const LOOSE = new Set(['drcViolations', 'ercViolations']);
function matches(key, actual, expected) {
  if (!LOOSE.has(key) || typeof actual !== 'number' || typeof expected !== 'number') {
    return actual === expected;
  }
  return Math.abs(actual - expected) <= Math.max(1, Math.floor(expected * 0.01));
}

const testsDir = import.meta.dirname;
const demosDir = path.resolve(testsDir, '..', 'upstream', 'demos');
const goldenFile = path.join(testsDir, 'golden', 'corpus.json');

function cli(args, { allowExit = [0] } = {}) {
  const result = spawnSync(stagedProgram('kicad-cli'), args, {
    env: { ...process.env, ...stagedEnv() },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw new Error(`kicad-cli ${args.join(' ')}: ${result.error.message}`);
  if (!allowExit.includes(result.status ?? -1)) {
    throw new Error(
      `kicad-cli ${args.join(' ')} exited with ${result.status}:\n${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  return result;
}

/** Root schematics (named like their project) and boards, sorted. */
export function corpusFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.kicad_pcb')) files.push(full);
      else if (
        entry.name.endsWith('.kicad_sch') &&
        existsSync(full.replace(/\.kicad_sch$/, '.kicad_pro'))
      )
        files.push(full);
    }
  };
  walk(demosDir);
  return files.sort();
}

const relative = (file) => path.relative(demosDir, file).split(path.sep).join('/');

function checkSchematic(file, out) {
  const netlist = path.join(out, 'netlist.net');
  cli(['sch', 'export', 'netlist', '--output', netlist, file]);
  const net = readFileSync(netlist, 'utf8');
  const components = (net.match(/\(comp\s+\(ref /g) ?? []).length;
  const nets = (net.match(/\(net\s+\(code /g) ?? []).length;

  const ercFile = path.join(out, 'erc.json');
  cli(['sch', 'erc', '--format', 'json', '--output', ercFile, file]);
  const erc = JSON.parse(readFileSync(ercFile, 'utf8'));
  const violations = (erc.sheets ?? []).reduce(
    (n, sheet) => n + (sheet.violations?.length ?? 0),
    0,
  );
  return { components, nets, ercViolations: violations };
}

function checkBoard(file, out) {
  const drcFile = path.join(out, 'drc.json');
  cli(['pcb', 'drc', '--format', 'json', '--output', drcFile, file]);
  const drc = JSON.parse(readFileSync(drcFile, 'utf8'));

  const svg = path.join(out, 'board.svg');
  cli([
    'pcb',
    'export',
    'svg',
    '--layers',
    'F.Cu,B.Cu,Edge.Cuts',
    '--mode-single',
    '--output',
    svg,
    file,
  ]);
  const svgBytes = readFileSync(svg).byteLength;
  if (svgBytes < 200) throw new Error(`${relative(file)}: SVG export is empty`);

  return {
    drcViolations: drc.violations?.length ?? 0,
    unconnected: drc.unconnected_items?.length ?? 0,
  };
}

function runEngine() {
  const result = spawnSync(stagedProgram('triage-eda-engine'), ['--load-all', demosDir], {
    env: { ...process.env, ...stagedEnv() },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  if (result.error) throw new Error(`triage-eda-engine: ${result.error.message}`);
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('{'));
  const byFile = new Map();
  for (const line of lines) {
    const record = JSON.parse(line);
    byFile.set(relative(record.file), record);
  }
  if (result.status !== 0 && lines.length === 0) {
    throw new Error(
      `triage-eda-engine exited with ${result.status}:\n${result.stderr.slice(-3000)}`,
    );
  }
  return byFile;
}

export async function runCorpus({ update = false } = {}) {
  if (!existsSync(stagedProgram('kicad-cli'))) {
    throw new Error(`no staged kicad-cli in ${stageDir}: run the build and stage steps first`);
  }
  const scratch = path.join(testsDir, '..', 'build', 'corpus');
  rmSync(scratch, { recursive: true, force: true });

  const results = {};
  const failures = [];
  const files = corpusFiles();
  console.log(`kicad-demos corpus: ${files.length} root schematics and boards`);

  for (const [index, file] of files.entries()) {
    const name = relative(file);
    const out = path.join(scratch, String(index));
    mkdirSync(out, { recursive: true });
    const started = Date.now();
    try {
      results[name] = file.endsWith('.kicad_sch')
        ? checkSchematic(file, out)
        : checkBoard(file, out);
      console.log(
        `  ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)} s) ${JSON.stringify(results[name])}`,
      );
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.log(`  FAIL  ${name}: ${error.message.split('\n')[0]}`);
    }
  }

  console.log('triage-eda-engine --load-all');
  const engine = runEngine();
  for (const file of files) {
    const name = relative(file);
    const record = engine.get(name);
    if (!record) {
      failures.push(`${name}: the engine did not report it`);
      continue;
    }
    if (!record.ok) {
      failures.push(`${name}: the engine failed: ${record.error}`);
      continue;
    }
    if (record.groups === 0) failures.push(`${name}: the engine's display list is empty`);
    results[name] = {
      ...results[name],
      engineComponents: record.components,
      engineNets: record.nets,
      engineGroups: record.groups,
    };
    console.log(
      `  ok    ${name}: ${record.groups} groups, ${(record.bytes / 1e6).toFixed(1)} MB, ${record.ms} ms`,
    );
  }

  if (update) {
    mkdirSync(path.dirname(goldenFile), { recursive: true });
    writeFileSync(goldenFile, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Wrote ${path.relative(process.cwd(), goldenFile)}.`);
  } else if (existsSync(goldenFile)) {
    const golden = JSON.parse(readFileSync(goldenFile, 'utf8'));
    for (const [name, expected] of Object.entries(golden)) {
      const actual = results[name];
      if (!actual) {
        failures.push(`${name}: in the golden file but not checked`);
        continue;
      }
      for (const [key, value] of Object.entries(expected)) {
        if (!matches(key, actual[key], value)) {
          failures.push(`${name}: ${key} is ${actual[key]}, the golden file says ${value}`);
        }
      }
    }
  } else {
    failures.push(`no golden file ${goldenFile}: run with --update once`);
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} corpus check(s) failed:\n  ${failures.join('\n  ')}`);
  }
  console.log(`All ${files.length} corpus files pass.`);
}
