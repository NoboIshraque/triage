import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineState } from '../../src/vs/triage/node/engineSupervisor.js';
import { EngineSupervisor } from '../../src/vs/triage/node/engineSupervisor.js';
import { benchmarkDir, engineRequired, helloEngine } from './engine.js';

const executable = helloEngine();
if (engineRequired && !executable) {
  throw new Error(
    'TRIAGE_REQUIRE_ENGINE=1 but no hello engine is built (cmake --workflow --preset ci)',
  );
}

/** ROADMAP P0-4: at least 100 MB/s of binary frames. */
const TARGET_MB_PER_S = 100;

describe.skipIf(executable === undefined)('engine supervisor with the real hello engine', () => {
  const supervisor = new EngineSupervisor({
    executable: executable ?? '',
    name: 'hello-test',
    restartDelaysMs: [200, 500],
  });
  const states: EngineState[] = [];

  beforeAll(async () => {
    supervisor.onState((state) => states.push(state));
    await supervisor.start();
  });

  afterAll(async () => {
    await supervisor.stop();
  });

  it('starts the engine, which says Hello with its pid and version', () => {
    const state = supervisor.state;
    expect(state.kind).toBe('connected');
    if (state.kind === 'connected') {
      expect(state.pid).toBeGreaterThan(0);
      expect(state.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(states[0]).toEqual({ kind: 'starting' });
  });

  it('answers a ping', async () => {
    expect(await supervisor.ping()).toBeLessThan(1000);
  });

  it(`streams binary frames at ${TARGET_MB_PER_S} MB/s or more`, async () => {
    await supervisor.stream(8, 1 << 20); // warm-up
    const runs = [];
    for (const [frames, size] of [
      [256, 1 << 20],
      [1024, 256 << 10],
      [8192, 64 << 10],
    ] as const) {
      const result = await supervisor.stream(frames, size);
      expect(result.bytes).toBe(frames * size);
      expect(result.frames).toBe(frames);
      runs.push({ frameSize: size, ...result });
    }
    const report = {
      what: 'hello engine -> broker (Node), binary frames over a local socket',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      runs: runs.map((r) => ({
        frameSize: r.frameSize,
        mebibytes: r.bytes / 2 ** 20,
        milliseconds: Math.round(r.milliseconds),
        megabytesPerSecond: Math.round(r.megabytesPerSecond),
      })),
    };
    mkdirSync(benchmarkDir, { recursive: true });
    writeFileSync(
      path.join(benchmarkDir, `hello-engine-${process.platform}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
    for (const run of runs) expect(run.megabytesPerSecond).toBeGreaterThan(TARGET_MB_PER_S);
  });

  it('shows "reconnecting" when the engine is killed, then recovers with a new process', async () => {
    const before = supervisor.state;
    expect(before.kind).toBe('connected');
    const oldPid = before.kind === 'connected' ? before.pid : -1;

    const seen: string[] = [];
    const dispose = supervisor.onState((state) => seen.push(state.kind));
    supervisor.kill();
    await new Promise<void>((resolve) => {
      const stop = supervisor.onState((state) => {
        if (state.kind === 'connected') {
          stop();
          resolve();
        }
      });
    });
    dispose();

    expect(seen).toEqual(['reconnecting', 'connected']);
    const after = supervisor.state;
    expect(after.kind === 'connected' && after.pid).not.toBe(oldPid);
    expect(after.kind === 'connected' && after.restarts).toBe(1);
    expect(await supervisor.ping()).toBeLessThan(1000);
  });
});
