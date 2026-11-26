#!/usr/bin/env node
// Generates the Smart Fan's enclosure (examples/smart-fan/mechanical/enclosure.FCStd)
// from its board (ROADMAP P2-4), with Triage's own engines, so stock FreeCAD opens it:
//
//   1. KiCad's engine reads the board (triage-eda-engine --dump writes GetBoard3D's
//      answer as <prefix>.board3d.json);
//   2. the CAD engine builds the board (board.update) and an enclosure around it
//      (enclosure.fromBoard) in a new document, and saves it.
//
// The board's JSON is also kept as engines/cad/tests/fixtures/smart-fan-board3d.json,
// so the CAD engine's tests (and its CI, which has no KiCad) use the real board.
//
//   node scripts/examples/smart-fan-enclosure.mjs     (after building both engines)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { startEngine } from '../../engines/cad/tests/client.mjs';
import { stagedEnv as edaEnv, stagedProgram as edaProgram } from '../../engines/eda/stage.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const example = path.join(repoRoot, 'examples', 'smart-fan');
const board = path.join(example, 'electronics', 'smart-fan.kicad_pcb');
const output = path.join(example, 'mechanical', 'enclosure.FCStd');
const fixture = path.join(
  repoRoot,
  'engines',
  'cad',
  'tests',
  'fixtures',
  'smart-fan-board3d.json',
);

const work = mkdtempSync(path.join(os.tmpdir(), 'triage-enclosure-'));
try {
  const engine = edaProgram('triage-eda-engine');
  if (!existsSync(engine)) throw new Error(`${engine} is missing: build engines/eda first`);
  const prefix = path.join(work, 'board');
  const dump = spawnSync(engine, ['--dump', board, '--out', prefix], {
    env: { ...process.env, ...edaEnv() },
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  if (dump.status !== 0) {
    throw new Error(`triage-eda-engine --dump exited with ${dump.status}:\n${dump.stderr}`);
  }
  const board3d = JSON.parse(readFileSync(`${prefix}.board3d.json`, 'utf8'));
  mkdirSync(path.dirname(fixture), { recursive: true });
  writeFileSync(fixture, `${JSON.stringify(board3d, null, 1)}\n`);
  console.log(
    `Board: ${board3d.footprints?.length ?? 0} footprints, ${board3d.holes?.length ?? 0} holes -> ${path.relative(repoRoot, fixture)}`,
  );

  const cad = await startEngine();
  try {
    const { result: built } = await cad.call('board.update', { board: board3d });
    const { result: doc } = await cad.call('document.new', { name: 'Enclosure' });
    const { result: enclosure } = await cad.call('enclosure.fromBoard', { doc: doc.name });
    if (enclosure.recompute.errors.length > 0) {
      throw new Error(
        `the enclosure didn't recompute: ${JSON.stringify(enclosure.recompute.errors)}`,
      );
    }
    for (const solid of enclosure.solids) {
      if (!solid.valid || !solid.closed)
        throw new Error('the enclosure is not a valid closed solid');
    }
    const { result: fit } = await cad.call('checks.fit', { docs: [built.doc, doc.name] });
    if (fit.problems.length > 0) {
      throw new Error(
        `the board doesn't fit its own enclosure: ${JSON.stringify(fit.problems.map((p) => p.message))}`,
      );
    }
    // FreeCAD keeps a replaced file as a .FCBak backup; there is git for that.
    rmSync(output, { force: true });
    await cad.call('document.save', { doc: doc.name, path: output });
    const parts = built.parts.filter((p) => p.object).map((p) => `${p.reference} ${p.height} mm`);
    console.log(
      `Enclosure: ${enclosure.solids.map((s) => s.size.map((v) => v.toFixed(1)).join(' x ')).join(' and ')} mm`,
    );
    console.log(`Parts in 3D: ${parts.join(', ')}`);
    console.log(`Wrote ${path.relative(repoRoot, output)}`);
  } finally {
    await cad.stop();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
