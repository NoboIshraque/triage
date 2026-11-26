// The CAD engine end to end (ROADMAP P2-2): FreeCAD's App layer from engines/cad
// (staged by `node engines/cad/build.mjs`), running Triage's engine host in
// FreeCADCmd under the P0-4 supervisor and speaking JSON-RPC over the engine
// connection. Skipped when the engine isn't built, unless TRIAGE_REQUIRE_CAD=1
// (CI's CAD workflow).
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
import {
  CadFrame,
  decodeResponse,
  encodeRequest,
  meshRequestId,
  readMesh,
} from '../../src/vs/triage/common/cad/cadEngine.js';
import type {
  CadDocument,
  CadMesh,
  CadProperty,
  CadRecompute,
  CadResponse,
  CadTessellation,
} from '../../src/vs/triage/common/cad/cadEngine.js';
import { EngineSupervisor } from '../../src/vs/triage/node/engineSupervisor.js';
import { benchmarkDir } from './engine.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const osName = process.platform === 'win32' ? 'windows' : 'linux';
const stage = path.join(repoRoot, 'engines', 'cad', 'build', osName, 'stage');
const freecad = path.join(
  stage,
  'bin',
  process.platform === 'win32' ? 'FreeCADCmd.exe' : 'FreeCADCmd',
);
const script = path.join(stage, 'triage', 'triage_cad_engine.py');
const required = process.env.TRIAGE_REQUIRE_CAD === '1';
const available = existsSync(freecad) && existsSync(script);
if (required && !available) throw new Error(`TRIAGE_REQUIRE_CAD is set but ${freecad} is missing`);

const mechanical = path.join(repoRoot, 'examples', 'smart-fan', 'mechanical');

/** The Smart Fan's FreeCAD documents: those its triage.toml lists. */
function smartFanDocuments(): string[] {
  const manifest = readFileSync(
    path.join(repoRoot, 'examples', 'smart-fan', 'triage.toml'),
    'utf8',
  );
  const list = /\[mechanical\][^[]*?documents\s*=\s*\[([^\]]*)\]/s.exec(manifest)?.[1] ?? '';
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** One request -> its response and the meshes sent before it. */
class CadClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: { response: CadResponse; meshes: CadMesh[] }) => void; meshes: CadMesh[] }
  >();

  constructor(readonly supervisor: EngineSupervisor) {
    supervisor.onFrame((frame) => {
      if (frame.type === CadFrame.Mesh) {
        this.pending
          .get(meshRequestId(frame.payload))
          ?.meshes.push(readMesh(frame.payload.slice()));
      } else if (frame.type === CadFrame.Response) {
        const response = decodeResponse(frame.payload);
        const pending = this.pending.get(response.id ?? -1);
        this.pending.delete(response.id ?? -1);
        pending?.resolve({ response, meshes: pending.meshes });
      }
    });
  }

  // T names the result's shape for the caller; the engine's JSON isn't checked against it.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async call<T>(method: string, params?: unknown): Promise<{ result: T; meshes: CadMesh[] }> {
    const { response, meshes } = await this.raw(method, params);
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return { result: response.result as T, meshes };
  }

  raw(method: string, params?: unknown): Promise<{ response: CadResponse; meshes: CadMesh[] }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, meshes: [] });
      this.supervisor.send(CadFrame.Request, encodeRequest(id, method, params));
    });
  }
}

describe.skipIf(!available)('CAD engine (FreeCAD App layer over JSON-RPC)', () => {
  let work: string;
  let supervisor: EngineSupervisor;
  let client: CadClient;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'triage-cad-'));
    mkdirSync(path.join(work, 'home'));
    cpSync(mechanical, path.join(work, 'mechanical'), { recursive: true });
    supervisor = new EngineSupervisor({
      executable: freecad,
      name: 'cad',
      args: [script, '--pass'],
      env: {
        FREECAD_USER_HOME: path.join(work, 'home'),
        ...(process.platform === 'win32'
          ? { PATH: `${path.join(stage, 'bin')};${process.env.PATH ?? ''}` }
          : {}),
      },
      helloTimeoutMs: 60_000,
    });
    client = new CadClient(supervisor);
    const started = Date.now();
    await supervisor.start();
    timings.helloMs = Date.now() - started;
  }, 90_000);

  afterAll(async () => {
    await supervisor.stop();
    if (work) rmSync(work, { recursive: true, force: true });
    mkdirSync(benchmarkDir, { recursive: true });
    writeFileSync(
      path.join(benchmarkDir, `cad-engine-${process.platform}.json`),
      `${JSON.stringify(timings, null, 2)}\n`,
    );
  });

  it('says Hello with its FreeCAD version and answers engine.info', async () => {
    const state = supervisor.state;
    expect(state.kind).toBe('connected');
    expect(state.kind === 'connected' ? state.version : '').toMatch(/^1\.1\.\d+$/);
    const { result } = await client.call<{ freecad: string; modules: string[]; occt: string }>(
      'engine.info',
    );
    expect(result.freecad).toMatch(/^1\.1\.\d+$/);
    expect(result.modules).toEqual(
      expect.arrayContaining(['Part', 'PartDesign', 'Sketcher', 'Import', 'Mesh']),
    );
    expect(result.occt).toMatch(/^7\./);
  });

  // ROADMAP P2-2, done when: open and recompute every Smart Fan document over RPC.
  it('opens and recomputes every Smart Fan document', async () => {
    const names = smartFanDocuments();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const file = path.join(work, 'mechanical', name);
      expect(existsSync(file), `${name} is in examples/smart-fan/mechanical`).toBe(true);
      const opened = await client.call<CadDocument>('document.open', { path: file });
      expect(opened.result.objects.length).toBeGreaterThan(0);
      // force: every feature is rebuilt, not only what changed since saving.
      const started = Date.now();
      const { result } = await client.call<CadRecompute>('document.recompute', {
        doc: opened.result.name,
        force: true,
      });
      expect(result.recomputed).toBe(opened.result.objects.length);
      timings[`recompute ${name} ms`] = Date.now() - started;
      expect(result.errors).toEqual([]);
      const tree = await client.call<CadDocument>('document.tree', { doc: opened.result.name });
      for (const item of tree.result.objects) {
        expect(item.state, `${name}: ${item.name}`).not.toContain('Invalid');
      }
    }
  });

  it('streams meshes of what the 3D view draws', async () => {
    const opened = await client.call<CadDocument>('document.open', {
      path: path.join(work, 'mechanical', 'fan.FCStd'),
    });
    expect(opened.result.objects.filter((o) => o.shown).map((o) => o.name)).toEqual(['Rotor']);
    const started = Date.now();
    const { result, meshes } = await client.call<CadTessellation>('document.tessellate', {
      doc: opened.result.name,
      deflection: 0.1,
    });
    timings.tessellateFanMs = Date.now() - started;
    expect(result.meshes).toHaveLength(1);
    expect(meshes).toHaveLength(1);
    const [info] = result.meshes;
    const [mesh] = meshes;
    expect(mesh.index).toBe(0);
    expect(mesh.positions.length).toBe(info.vertices * 3);
    expect(mesh.indices.length).toBe(info.triangles * 3);
    expect(mesh.faceStart.length).toBe(info.faces + 1);
    expect(mesh.faceStart[info.faces]).toBe(info.triangles);
    expect(mesh.edgeStart.length).toBe(info.edges + 1);
    // Five blades on a hub, with a hole for the motor's shaft.
    expect(info.volume).toBeGreaterThan(7000);
    expect(info.volume).toBeLessThan(9000);
    // Every vertex lies inside the bounding box the engine reports.
    const [x0, y0, z0, x1, y1, z1] = info.box;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeGreaterThanOrEqual(x0 - 0.01);
      expect(mesh.positions[i]).toBeLessThanOrEqual(x1 + 0.01);
      expect(mesh.positions[i + 1]).toBeGreaterThanOrEqual(y0 - 0.01);
      expect(mesh.positions[i + 1]).toBeLessThanOrEqual(y1 + 0.01);
      expect(mesh.positions[i + 2]).toBeGreaterThanOrEqual(z0 - 0.01);
      expect(mesh.positions[i + 2]).toBeLessThanOrEqual(z1 + 0.01);
    }
    for (const index of mesh.indices) expect(index).toBeLessThan(info.vertices);
  });

  it('edits a property, recomputes, undoes and saves a file FreeCAD reopens', async () => {
    const file = path.join(work, 'mechanical', 'fan.FCStd');
    const doc = (await client.call<CadDocument>('document.open', { path: file })).result.name;
    const props = await client.call<{ properties: CadProperty[] }>('object.properties', {
      doc,
      object: 'Hub',
    });
    expect(props.result.properties.find((p) => p.name === 'Length')).toMatchObject({
      type: 'App::PropertyLength',
      value: { value: 12 },
      readOnly: false,
    });
    const box = async () =>
      (await client.call<CadTessellation>('document.tessellate', { doc, objects: ['Rotor'] }))
        .result.meshes[0].box;
    expect((await box())[5]).toBeCloseTo(12, 3);

    const edited = await client.call<{ recompute: CadRecompute }>('object.setProperty', {
      doc,
      object: 'Hub',
      property: 'Length',
      value: '20 mm',
    });
    expect(edited.result.recompute.errors).toEqual([]);
    expect((await box())[5]).toBeCloseTo(20, 3);

    const undone = await client.call<CadDocument>('document.undo', { doc });
    expect(undone.result.canRedo).toBe(true);
    expect((await box())[5]).toBeCloseTo(12, 3);

    await client.call('object.setProperty', { doc, object: 'Hub', property: 'Length', value: 15 });
    const saved = path.join(work, 'fan-saved.FCStd');
    await client.call('document.save', { doc, path: saved });
    await client.call('document.close', { doc });
    const reopened = (
      await client.call<CadDocument>('document.open', { path: saved, recompute: true })
    ).result.name;
    expect(
      (
        await client.call<{ properties: CadProperty[] }>('object.properties', {
          doc: reopened,
          object: 'Hub',
        })
      ).result.properties.find((p) => p.name === 'Length')?.value,
    ).toMatchObject({ value: 15 });
    await client.call('document.close', { doc: reopened });
  });

  it('answers bad requests with JSON-RPC errors and keeps serving', async () => {
    expect((await client.raw('no.such.method')).response.error?.code).toBe(-32601);
    expect((await client.raw('document.tree', { doc: 'Missing' })).response.error?.code).toBe(
      -32001,
    );
    expect((await client.raw('document.open', {})).response.error?.code).toBe(-32602);
    const fan = (
      await client.call<CadDocument>('document.open', {
        path: path.join(work, 'mechanical', 'fan.FCStd'),
      })
    ).result.name;
    expect(
      (
        await client.raw('object.setProperty', {
          doc: fan,
          object: 'Hub',
          property: 'Length',
          value: 'not a length',
        })
      ).response.error,
    ).toBeDefined();
    expect((await client.call<unknown[]>('document.list')).result.length).toBeGreaterThan(0);
  });

  // ROADMAP P2-4, P2-5: the Smart Fan's real board (GetBoard3D, kept as a fixture by
  // scripts/examples/smart-fan-enclosure.mjs), its enclosure and the fit checks.
  const boardFixture = path.join(
    repoRoot,
    'engines',
    'cad',
    'tests',
    'fixtures',
    'smart-fan-board3d.json',
  );
  interface BoardResult {
    doc: string;
    parts: { reference: string; height: number; object: string | null }[];
    mountingHoles: unknown[];
  }
  interface Fit {
    problems: {
      severity: string;
      kind: string;
      message: string;
      a: { object: string };
      b: { object: string };
    }[];
  }

  it('gives the Smart Fan board a printable enclosure that follows it', async () => {
    const board = JSON.parse(readFileSync(boardFixture, 'utf8')) as Record<string, unknown>;
    const built = (await client.call<BoardResult>('board.update', { board })).result;
    expect(built.parts.filter((p) => p.object).length).toBeGreaterThan(3);
    expect(built.mountingHoles.length).toBeGreaterThan(0);

    const enclosurePath = path.join(work, 'mechanical', 'enclosure.FCStd');
    const doc = (await client.call<CadDocument>('document.open', { path: enclosurePath })).result
      .name;
    const item = (await client.call<CadDocument>('document.tree', { doc })).result.objects.find(
      (o) => o.proxy === 'Enclosure',
    );
    expect(item).toBeDefined();
    const enclosure = await client.call<{ solids: { valid: boolean; closed: boolean }[] }>(
      'enclosure.fromBoard',
      { doc },
    );
    expect(enclosure.result.solids).toHaveLength(2);
    for (const solid of enclosure.result.solids)
      expect(solid).toMatchObject({ valid: true, closed: true });

    // Done when: changing the wall thickness recomputes live.
    const tessellate = async () =>
      (await client.call<CadTessellation>('document.tessellate', { doc })).result.meshes[0];
    const before = await tessellate();
    const started = Date.now();
    const edited = await client.call<{ recompute: CadRecompute }>('object.setProperty', {
      doc,
      object: item?.name ?? 'Enclosure',
      property: 'WallThickness',
      value: '3 mm',
    });
    const after = await tessellate();
    timings.wallThicknessMs = Date.now() - started;
    expect(edited.result.recompute.errors).toEqual([]);
    expect(after.box[3] - after.box[0]).toBeCloseTo(before.box[3] - before.box[0] + 2, 3);

    // Printable: each part as a closed STL.
    const exported = await client.call<{
      files: { path: string; valid: boolean; closed: boolean }[];
    }>('enclosure.export', { doc, folder: path.join(work, 'exports') });
    expect(exported.result.files.map((f) => path.basename(f.path))).toEqual([
      'base.stl',
      'lid.stl',
    ]);
    for (const file of exported.result.files) {
      expect(file).toMatchObject({ valid: true, closed: true });
      expect(existsSync(file.path)).toBe(true);
    }

    // The board fits its enclosure.
    const fit = (await client.call<Fit>('checks.fit', { docs: [built.doc, doc] })).result;
    expect(fit.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  // ROADMAP P2-5, done when: a deliberately tall part is a problem.
  it('finds a deliberately tall part that hits the lid', async () => {
    const board = JSON.parse(readFileSync(boardFixture, 'utf8')) as {
      footprints: { reference: string; height?: number }[];
    };
    const tall = board.footprints.find((f) => f.reference === 'R1') ?? board.footprints[0];
    tall.height = 60;
    const built = (await client.call<BoardResult>('board.update', { board })).result;
    const doc = (
      await client.call<CadDocument>('document.open', {
        path: path.join(work, 'mechanical', 'enclosure.FCStd'),
      })
    ).result.name;
    await client.call('enclosure.fromBoard', { doc });
    const fit = (await client.call<Fit>('checks.fit', { docs: [built.doc, doc] })).result;
    const errors = fit.problems.filter((p) => p.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].kind).toBe('interference');
    expect(errors.some((p) => p.message.includes(tall.reference))).toBe(true);
  });

  it('comes back after being killed', async () => {
    const before = supervisor.state.kind === 'connected' ? supervisor.state.pid : -1;
    supervisor.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await supervisor.whenConnected();
    timings.restartMs = Date.now() - started;
    expect(supervisor.state).toMatchObject({ kind: 'connected', restarts: 1 });
    expect(supervisor.state.kind === 'connected' && supervisor.state.pid).not.toBe(before);
    const { result } = await client.call<CadDocument>('document.open', {
      path: path.join(work, 'mechanical', 'fan.FCStd'),
    });
    expect(result.objects.length).toBeGreaterThan(0);
  });
});
