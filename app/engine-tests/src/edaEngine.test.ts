// The EDA engine end to end (ROADMAP P1-2 … P1-6): the real triage-eda-engine
// (engines/eda, staged by `node engines/eda/build.mjs`) under the P0-4 supervisor,
// speaking triage.eda.v1 over the engine connection. Skipped when the engine
// isn't built, unless TRIAGE_REQUIRE_EDA=1 (CI's EDA workflow).
//
// The codec decodes into untyped records (protobuf.ts), so this file reads them
// as `any`; the generated descriptors keep the field names in step with the API.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisplayListModel, readChunkHeader } from '../../src/vs/triage/common/eda/displayList.js';
import * as api from '../../src/vs/triage/common/eda/engineApi.generated.js';
import { decodeMessage, encodeMessage } from '../../src/vs/triage/common/eda/protobuf.js';
import type { Message } from '../../src/vs/triage/common/eda/protobuf.js';
import { EngineSupervisor } from '../../src/vs/triage/node/engineSupervisor.js';
import { benchmarkDir } from './engine.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const osName = process.platform === 'win32' ? 'windows' : 'linux';
const stage = path.join(repoRoot, 'engines', 'eda', 'build', osName, 'stage', 'bin');
const exe =
  process.env.TRIAGE_EDA_ENGINE ??
  path.join(stage, process.platform === 'win32' ? 'triage-eda-engine.exe' : 'triage-eda-engine');
const required = process.env.TRIAGE_REQUIRE_EDA === '1';
const available = existsSync(exe);
if (required && !available) throw new Error(`TRIAGE_REQUIRE_EDA is set but ${exe} is missing`);

/** One request -> its response and display-list chunks. */
class EdaClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: { response: Message; chunks: Uint8Array[] }) => void; chunks: Uint8Array[] }
  >();

  constructor(readonly supervisor: EngineSupervisor) {
    supervisor.onFrame((frame) => {
      if (process.env.TRIAGE_EDA_TRACE) console.log('frame', frame.type, frame.payload.length);
      if (frame.type === 0x22) {
        this.pending
          .get(readChunkHeader(frame.payload).requestId)
          ?.chunks.push(frame.payload.slice());
      } else if (frame.type === 0x21) {
        let response: Message;
        try {
          response = decodeMessage(api.Response, frame.payload);
        } catch (error) {
          console.error(
            'undecodable response',
            error,
            Buffer.from(frame.payload).toString('hex').slice(0, 400),
          );
          throw error;
        }
        const pending = this.pending.get(response.id as number);
        this.pending.delete(response.id as number);
        pending?.resolve({ response, chunks: pending.chunks });
      }
    });
  }

  call(command: string, body: Message): Promise<{ response: Message; chunks: Uint8Array[] }> {
    const id = this.nextId++;
    if (process.env.TRIAGE_EDA_TRACE) console.log('call', id, command);
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, chunks: [] });
      this.supervisor.send(0x20, encodeMessage(api.Request, { id, [command]: body }));
    });
  }

  async ok(command: string, body: Message): Promise<{ response: Message; chunks: Uint8Array[] }> {
    const result = await this.call(command, body);
    if (!result.response.ok) throw new Error(`${command}: ${String(result.response.error)}`);
    return result;
  }
}

describe.skipIf(!available)('triage-eda-engine', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'triage-eda-'));
  const project = path.join(scratch, 'electronics');
  cpSync(path.join(repoRoot, 'examples', 'smart-fan', 'electronics'), project, { recursive: true });
  const schematic = path.join(project, 'smart-fan.kicad_sch');
  const board = path.join(project, 'smart-fan.kicad_pcb');
  let supervisor: EngineSupervisor;
  let eda: EdaClient;

  beforeAll(async () => {
    const env: Record<string, string> =
      process.platform === 'win32'
        ? { PATH: `${stage};${process.env.PATH ?? ''}` }
        : { LD_LIBRARY_PATH: stage };
    supervisor = new EngineSupervisor({
      executable: exe,
      name: 'eda-test',
      env,
      helloTimeoutMs: 60_000,
    });
    eda = new EdaClient(supervisor);
    await supervisor.start();
  });

  afterAll(async () => {
    await supervisor.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('says its version and loads both kifaces', async () => {
    const { response } = await eda.ok('getVersion', {});
    expect(response.version.engine).toMatch(/^triage-eda-engine \d+\.\d+\.\d+$/);
    expect(response.version.kicad).toMatch(/^10\.0\.8/);
    expect(response.version.faces).toEqual(['pcb', 'sch']);
  });

  it('opens the board, streams its display list and answers queries', async () => {
    const opened = await eda.ok('openDocument', { path: board });
    const document = opened.response.document.document as number;
    expect(opened.response.document.kind).toBe(api.DocumentKind.DOCUMENT_KIND_BOARD);

    const list = await eda.ok('getDisplayList', { document });
    const model = new DisplayListModel();
    for (const chunk of list.chunks) model.apply(chunk);
    expect(model.groups.size).toBe(list.response.displayList.groups);
    expect(model.stats().segments).toBeGreaterThan(100);

    const netlist = (await eda.ok('getNetlist', { document })).response.netlist;
    const q1 = (netlist.components as Message[]).find((c) => c.reference === 'Q1');
    expect(q1?.value).toBe('IRLZ44N');
    expect((q1?.pins as Message[]).map((p) => p.net)).toEqual(['/FAN_GATE', '/FAN_NEG', '/GND']);

    const items = (await eda.ok('getItems', { document, references: ['Q1'] })).response.items
      .items as Message[];
    expect(items).toHaveLength(1);
    const hit = await eda.ok('hitTest', {
      document,
      x: items[0].x,
      y: items[0].y,
      tolerance: 100_000,
    });
    expect((hit.response.hitTest.items as Message[]).some((i) => i.reference === 'Q1')).toBe(true);

    const selected = await eda.ok('setSelection', { document, uuids: [items[0].uuid] });
    expect(selected.chunks.length).toBeGreaterThan(0);
    const lit = await eda.ok('highlight', { document, net: '/FAN_GATE' });
    expect(lit.response.ok).toBe(true);
  });

  it('edits the board, undoes, redoes and saves a file stock KiCad reads', async () => {
    const document = (await eda.ok('openDocument', { path: board })).response.document
      .document as number;
    const [q1] = (await eda.ok('getItems', { document, references: ['Q1'] })).response.items
      .items as Message[];
    const moved = await eda.ok('edit', {
      document,
      move: { uuids: [q1.uuid], dx: 2_540_000, dy: 0 },
    });
    expect(moved.response.edit.undoDepth).toBe(1);
    const [after] = (await eda.ok('getItems', { document, uuids: [q1.uuid] })).response.items
      .items as Message[];
    expect(after.x - q1.x).toBe(2_540_000);
    await eda.ok('edit', { document, rotate: { uuids: [q1.uuid], degrees: 90 } });
    await eda.ok('undo', { document });
    const redone = await eda.ok('redo', { document });
    expect(redone.response.edit.undoDepth).toBe(2);
    await eda.ok('edit', {
      document,
      setField: { uuid: q1.uuid, field: 'Value', text: 'AO3400A' },
    });
    await eda.ok('save', { document });
    const text = readFileSync(board, 'utf8');
    expect(text).toContain('"AO3400A"');
  });

  it("routes a track with KiCad's router within the 16 ms budget (P1-6 spike)", async () => {
    const document = (await eda.ok('openDocument', { path: board })).response.document
      .document as number;
    const netlist = (await eda.ok('getNetlist', { document })).response.netlist;
    const pad = (ref: string, number: string) =>
      ((netlist.components as Message[]).find((c) => c.reference === ref)?.pins as Message[]).find(
        (p) => p.number === number,
      )?.uuid as string;
    const [from, to] = (
      await eda.ok('getItems', { document, uuids: [pad('R2', '1'), pad('A1', '24')] })
    ).response.items.items as Message[];
    const moves: number[] = [];
    for (let i = 1; i <= 40; i++) {
      moves.push(from.x + ((to.x - from.x) * i) / 40, from.y + ((to.y - from.y) * i) / 40);
    }
    const routed = await eda.ok('route', {
      document,
      x: from.x,
      y: from.y,
      moves,
      layer: -1,
      commit: true,
      shove: true,
    });
    const result = routed.response.route as Message;
    mkdirSync(benchmarkDir, { recursive: true });
    writeFileSync(
      path.join(benchmarkDir, `eda-route-${process.platform}.json`),
      `${JSON.stringify({ what: "KiCad's push-and-shove router hosted in the engine: time per cursor move", ...result }, null, 2)}\n`,
    );
    expect(result.moves).toBe(40);
    expect(result.committed).toBe(true);
    expect(result.added).toBeGreaterThan(0);
    expect(result.averageMs).toBeLessThan(16);
  });

  it('selects and highlights a part in the schematic (cross-probe)', async () => {
    const document = (await eda.ok('openDocument', { path: schematic })).response.document
      .document as number;
    const items = (await eda.ok('getItems', { document, references: ['Q1'] })).response.items
      .items as Message[];
    expect(items.map((item) => item.reference)).toEqual(['Q1']);
    const selected = await eda.ok('setSelection', { document, uuids: [items[0].uuid] });
    expect(selected.chunks.length).toBeGreaterThan(0);
    await eda.ok('highlight', { document, net: '/FAN_GATE' });
    await eda.ok('setSelection', { document, uuids: [] });
  });

  it('reloads the board from disk', async () => {
    const document = (await eda.ok('openDocument', { path: board })).response.document
      .document as number;
    const reloaded = await eda.ok('reload', { document });
    expect(reloaded.response.document.document).toBe(document);
    const list = await eda.ok('getDisplayList', { document });
    expect(list.response.displayList.groups).toBeGreaterThan(0);
  });

  it('renames a net in the schematic and saves it', async () => {
    const document = (await eda.ok('openDocument', { path: schematic })).response.document
      .document as number;
    await eda.ok('edit', { document, renameNet: { from: 'FAN_PWM', to: 'MOTOR_SPEED' } });
    const netlist = (await eda.ok('getNetlist', { document })).response.netlist;
    expect((netlist.nets as Message[]).map((n) => n.name)).toContain('/MOTOR_SPEED');
    await eda.ok('save', { document });
    expect(readFileSync(schematic, 'utf8')).toContain('"MOTOR_SPEED"');
  });

  // ROADMAP P2-3 … P2-5: the board the 3D view and the enclosure are built from.
  it('describes the board in 3D, with a height field added by an edit', async () => {
    const document = (await eda.ok('openDocument', { path: board })).response.document
      .document as number;
    const read = async () => (await eda.ok('getBoard3d', { document })).response.board3d;
    const before = await read();
    expect(before.outlineOk).toBe(true);
    expect(before.thickness).toBeCloseTo(1.6, 3);
    expect(before.outlines).toHaveLength(1);
    expect((before.outlines[0].points as Message[]).length).toBeGreaterThanOrEqual(4);
    const references = (before.footprints as Message[]).map((f) => f.reference as string);
    expect(references).toEqual(expect.arrayContaining(['A1', 'Q1', 'J1', 'H1', 'H2', 'H3']));
    const h1 = (before.footprints as Message[]).find((f) => f.reference === 'H1');
    expect(h1?.boardOnly).toBe(true);
    const holes = (before.holes as Message[]).filter((h) => h.footprint === 'H1');
    expect(holes.length).toBeGreaterThan(0);
    expect(holes.some((h) => !h.plated && h.width >= 3)).toBe(true);
    const q1 = (before.footprints as Message[]).find((f) => f.reference === 'Q1');
    expect((q1?.courtyard as Message[]).length).toBeGreaterThanOrEqual(4);
    expect(q1?.height ?? 0).toBe(0);

    // A new user field, as the 3D tab's "Set a Part's Height" writes it: the live
    // board answers with it before anything is saved.
    await eda.ok('edit', {
      document,
      setField: { uuid: q1?.uuid, field: 'Height', text: '19 mm' },
    });
    const after = await read();
    expect((after.footprints as Message[]).find((f) => f.reference === 'Q1')?.height).toBe(19);
    await eda.ok('undo', { document });
    const undone = await read();
    expect((undone.footprints as Message[]).find((f) => f.reference === 'Q1')?.height ?? 0).toBe(0);
  });

  it('comes back after being killed', async () => {
    const before = supervisor.state;
    supervisor.kill();
    await expect.poll(() => supervisor.state.kind, { timeout: 30_000 }).toBe('reconnecting');
    await expect.poll(() => supervisor.state.kind, { timeout: 90_000 }).toBe('connected');
    expect(supervisor.state).not.toEqual(before);
    const { response } = await eda.ok('getVersion', {});
    expect(response.version.faces).toEqual(['pcb', 'sch']);
  });
});
