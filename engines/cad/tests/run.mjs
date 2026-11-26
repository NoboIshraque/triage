// FreeCAD's own module tests through the staged FreeCADCmd (ROADMAP P2-1: "FreeCADCmd
// from our tree runs the Part/PartDesign tests on both OSes").
//
// tests/module_tests.py runs FreeCAD's Part, Sketcher and PartDesign test suites inside
// FreeCADCmd and writes every test's outcome. The result must match the golden file
// tests/golden/module-tests.json: every test passes there, except the ones it lists
// with the outcome they have and why (per OS where the systems differ, for example
// Ubuntu's older OpenCASCADE on Linux). A new failure, a test that now passes or a
// suite that doesn't load fails the check. `node engines/cad/build.mjs test --update`
// rewrites the golden file's list from this machine's run, keeping the reasons.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stagedEnv, stagedProgram } from '../stage.mjs';

const testsDir = import.meta.dirname;
const goldenFile = path.join(testsDir, 'golden', 'module-tests.json');
const osName = process.platform === 'win32' ? 'windows' : 'linux';

/** FreeCAD's suites (each module's Init.py registers its own in FreeCAD.__unit_test__). */
export const SUITES = ['TestPartApp', 'TestSketcherApp', 'TestPartDesignApp'];

/** Runs the suites in a fresh FreeCADCmd and returns its report. */
export function runSuites(suites = SUITES) {
  const program = stagedProgram('FreeCADCmd');
  if (!existsSync(program)) throw new Error(`${program} is missing: build and stage first`);
  const work = mkdtempSync(path.join(os.tmpdir(), 'triage-cad-tests-'));
  try {
    const output = path.join(work, 'results.json');
    const home = path.join(work, 'home');
    mkdirSync(home);
    const result = spawnSync(program, [path.join(testsDir, 'module_tests.py')], {
      cwd: work,
      env: {
        ...process.env,
        ...stagedEnv(home),
        TRIAGE_TEST_SUITES: suites.join(','),
        TRIAGE_TEST_OUTPUT: output,
      },
      encoding: 'utf8',
      input: '',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 45 * 60 * 1000,
    });
    if (result.error) throw new Error(`FreeCADCmd: ${result.error.message}`);
    if (result.status !== 0 || !existsSync(output)) {
      throw new Error(
        `FreeCADCmd exited with ${result.status ?? result.signal}:\n${`${result.stdout}\n${result.stderr}`.slice(-4000)}`,
      );
    }
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Every test that didn't pass, by id: its outcome on this run. */
function notPassed(report) {
  const map = new Map();
  for (const suite of report.suites) {
    for (const test of suite.tests) {
      if (test.outcome !== 'passed') map.set(test.id, test);
    }
  }
  return map;
}

/**
 * Compares a run with the golden file's expectations for this OS. Returns the
 * differences as readable lines (none: the run matches).
 */
export function compare(report, golden, system = osName) {
  const problems = [];
  for (const suite of report.suites) {
    if (suite.loadError) problems.push(`${suite.name} didn't load:\n${suite.loadError}`);
    const minimum = golden.minimumTests?.[suite.name] ?? 1;
    if (suite.tests.length < minimum) {
      problems.push(
        `${suite.name} ran ${suite.tests.length} tests; the golden file expects ≥ ${minimum}`,
      );
    }
  }
  const expected = new Map(
    (golden.notPassing ?? [])
      .filter((entry) => !entry.os || entry.os.includes(system))
      .map((entry) => [entry.id, entry]),
  );
  for (const [id, test] of notPassed(report)) {
    const entry = expected.get(id);
    if (!entry) {
      problems.push(`${id}: ${test.outcome} (not in the golden file)\n${test.detail ?? ''}`.trim());
    } else if (entry.outcome !== test.outcome) {
      problems.push(`${id}: ${test.outcome}, the golden file says ${entry.outcome}`);
    }
    expected.delete(id);
  }
  for (const id of expected.keys()) {
    problems.push(`${id}: passed, the golden file says ${expected.get(id).outcome} (update it)`);
  }
  return problems;
}

function summary(report) {
  const lines = [
    `FreeCAD ${report.freecad}, OpenCASCADE ${report.occt ?? '?'}, Python ${report.python}` +
      (report.placeholders.length ? `; placeholders for ${report.placeholders.join(', ')}` : ''),
  ];
  for (const suite of report.suites) {
    const counts = {};
    for (const test of suite.tests) counts[test.outcome] = (counts[test.outcome] ?? 0) + 1;
    const parts = Object.entries(counts).map(([outcome, n]) => `${n} ${outcome}`);
    lines.push(
      `  ${suite.name}: ${suite.tests.length} tests (${parts.join(', ')}) in ${suite.seconds ?? '?'} s`,
    );
  }
  return lines.join('\n');
}

/** Writes this OS's not-passing tests into the golden file, keeping known reasons. */
function update(report, golden) {
  const previous = new Map((golden.notPassing ?? []).map((entry) => [entry.id, entry]));
  const others = (golden.notPassing ?? []).filter(
    (entry) => entry.os && !entry.os.includes(osName),
  );
  const mine = [...notPassed(report).values()].map((test) => {
    const old = previous.get(test.id);
    const systems = new Set(old?.os ?? []);
    systems.add(osName);
    return {
      id: test.id,
      outcome: test.outcome,
      os: [...systems].sort(),
      why: old?.why ?? (test.outcome === 'skipped' ? test.detail : 'TODO: why'),
    };
  });
  const ids = new Set(mine.map((entry) => entry.id));
  // Entries for other systems stay; one that now passes here loses this OS.
  const kept = others
    .filter((entry) => !ids.has(entry.id))
    .map((entry) => ({ ...entry, os: entry.os.filter((system) => system !== osName) }))
    .filter((entry) => entry.os.length > 0);
  const minimumTests = { ...(golden.minimumTests ?? {}) };
  for (const suite of report.suites) {
    minimumTests[suite.name] = Math.min(
      minimumTests[suite.name] ?? Number.POSITIVE_INFINITY,
      suite.tests.length,
    );
  }
  return {
    $comment: golden.$comment,
    minimumTests,
    notPassing: [...mine, ...kept].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function runModuleTests({ update: rewrite = false } = {}) {
  const report = runSuites();
  console.log(summary(report));
  const golden = existsSync(goldenFile)
    ? JSON.parse(readFileSync(goldenFile, 'utf8'))
    : {
        $comment:
          "Tests of FreeCAD's Part, Sketcher and PartDesign suites that don't pass in Triage's CAD engine, and why (engines/cad/tests/run.mjs).",
      };
  if (rewrite) {
    mkdirSync(path.dirname(goldenFile), { recursive: true });
    writeFileSync(goldenFile, `${JSON.stringify(update(report, golden), null, 2)}\n`);
    console.log(`Updated ${path.relative(process.cwd(), goldenFile)}.`);
    return;
  }
  const problems = compare(report, golden);
  if (problems.length > 0) {
    throw new Error(`the module tests differ from the golden file:\n${problems.join('\n')}`);
  }
  console.log('The module tests match the golden file.');
}
