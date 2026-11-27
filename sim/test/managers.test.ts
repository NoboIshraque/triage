// The Library and Boards Managers' engine (ROADMAP PA-4, PA-5), in a fresh Arduino
// folder of their own: a library installed from Arduino's index builds, runs in
// the simulator and draws on the simulated OLED; a platform installs from a package
// index (a local one, served here, with its checksum checked as Arduino's are) and
// compiles Blink for its board. They download Arduino's indexes and the library,
// so they need the network as well as Triage's Arduino engine; skipped without
// the engine unless TRIAGE_REQUIRE_TOOLCHAIN=1, and without the network unless
// TRIAGE_REQUIRE_NETWORK=1 (CI).
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addonAvailable } from '../src/addon.js';
import {
  findArduinoEngine,
  installLibrary,
  installPlatform,
  installedLibraries,
  listBoards,
  listPlatforms,
  prepareArduino,
  updateIndexes,
  withAdditionalUrls,
  type ArduinoSetup,
} from '../src/arduino.js';
import { buildFirmware } from '../src/firmware.js';
import { Runner } from '../src/runner.js';
import { WHOLE, smartFanDevice } from './helpers.js';

const engine = findArduinoEngine();
if (process.env['TRIAGE_REQUIRE_TOOLCHAIN'] === '1' && 'missing' in engine)
  throw new Error(engine.missing);
const online = (() => {
  if (process.env['TRIAGE_REQUIRE_NETWORK'] === '1') return true;
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "fetch('https://downloads.arduino.cc/packages/package_index.json',{method:'HEAD'}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
    ],
    { timeout: 15_000 },
  );
  return probe.status === 0;
})();
const ready = !('missing' in engine) && online;

const home = mkdtempSync(path.join(tmpdir(), 'triage-arduino-home-'));
let setup: ArduinoSetup;
const log = (): void => undefined;

beforeAll(() => {
  if (!ready) return;
  process.env['TRIAGE_ARDUINO_HOME'] = home;
  setup = prepareArduino();
});
afterAll(() => {
  delete process.env['TRIAGE_ARDUINO_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!ready)('the Library Manager (PA-4)', () => {
  it('installs Adafruit SSD1306; a sketch using it builds, runs and draws on the OLED', async () => {
    await updateIndexes(setup, log);
    await installLibrary(setup, 'Adafruit SSD1306', '2.5.17', log);
    const names = installedLibraries(setup).map((l) => l.name);
    // Its dependencies come with it, as in the Arduino IDE.
    expect(names).toEqual(expect.arrayContaining(['Adafruit SSD1306', 'Adafruit GFX Library']));
    const out = path.join(home, 'build', 'OledHello');
    const built = buildFirmware({
      setup,
      sourceDir: path.join(import.meta.dirname, 'firmware', 'OledHello'),
      board: 'arduino-uno',
      outDir: out,
    });
    expect(built.libraries.join(' ')).toContain('Adafruit SSD1306');
    if (!addonAvailable()) return;
    const runner = new Runner({
      device: smartFanDevice(),
      scope: WHOLE,
      firmwareHex: readFileSync(built.hex, 'utf8'),
    });
    runner.runFor(1.5);
    expect(runner.serialText).toContain('drawn');
    // The display's text reader knows the Smart Fan's 5×7 font; Adafruit's differs in a
    // few letters (T, A, G), so it reads "HELLO" and the rest only in part. Both rows
    // the sketch printed are lit.
    const display = runner.displays.get('J3');
    expect(display?.text ?? '').toContain('HELLO');
    const lit = (page: number) =>
      [...(display?.buffer.subarray(page * 128, page * 128 + 128) ?? [])].filter(Boolean).length;
    expect(lit(0)).toBeGreaterThan(40);
    expect(lit(2)).toBeGreaterThan(40);
    expect(lit(5)).toBe(0);
  }, 300_000);
});

describe.skipIf(!ready)('the Boards Manager (PA-5)', () => {
  let server: Server;
  let base = '';
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    // A platform that borrows the AVR core and compiler (build.core=arduino:arduino),
    // so its archive is just platform.txt and boards.txt.
    const avr = path.join(setup.dataDir, 'packages', 'arduino', 'hardware', 'avr', '1.8.8');
    const work = path.join(home, 'triagetest');
    const root = path.join(work, 'triagetest-avr');
    mkdirSync(root, { recursive: true });
    cpSync(path.join(avr, 'platform.txt'), path.join(root, 'platform.txt'));
    writeFileSync(
      path.join(root, 'boards.txt'),
      [
        'tuno.name=Triage Test Uno',
        'tuno.upload.tool=avrdude',
        'tuno.upload.tool.default=avrdude',
        'tuno.upload.protocol=arduino',
        'tuno.upload.maximum_size=32256',
        'tuno.upload.maximum_data_size=2048',
        'tuno.upload.speed=115200',
        'tuno.build.mcu=atmega328p',
        'tuno.build.f_cpu=16000000L',
        'tuno.build.board=AVR_TRIAGE_TEST',
        'tuno.build.core=arduino:arduino',
        'tuno.build.variant=arduino:standard',
        '',
      ].join('\n'),
    );
    const archive = path.join(work, 'triagetest-avr-1.0.0.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', work, 'triagetest-avr'], {
      encoding: 'utf8',
    });
    if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
    const bytes = readFileSync(archive);
    files.set('/triagetest-avr-1.0.0.tar.gz', bytes);
    server = createServer((request, response) => {
      const body = files.get(request.url ?? '');
      response.writeHead(body ? 200 : 404).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    files.set(
      '/package_triagetest_index.json',
      Buffer.from(
        JSON.stringify({
          packages: [
            {
              name: 'triagetest',
              maintainer: 'Triage tests',
              websiteURL: base,
              email: 'tests@example.invalid',
              help: { online: base },
              platforms: [
                {
                  name: 'Triage Test AVR Boards',
                  architecture: 'avr',
                  version: '1.0.0',
                  category: 'Contributed',
                  url: `${base}/triagetest-avr-1.0.0.tar.gz`,
                  archiveFileName: 'triagetest-avr-1.0.0.tar.gz',
                  checksum: `SHA-256:${createHash('sha256').update(bytes).digest('hex')}`,
                  size: String(statSync(archive).size),
                  boards: [{ name: 'Triage Test Uno' }],
                  toolsDependencies: [
                    { packager: 'arduino', name: 'avr-gcc', version: '7.3.0-atmel3.6.1-arduino7' },
                    { packager: 'arduino', name: 'avrdude', version: '8.0.0-arduino1' },
                  ],
                },
              ],
              tools: [],
            },
          ],
        }),
      ),
    );
  });
  afterAll(() => {
    server.close();
  });

  it('installs a platform from an extra index URL and compiles Blink for its board', async () => {
    const withTest = withAdditionalUrls(setup, [`${base}/package_triagetest_index.json`]);
    await updateIndexes(withTest, log);
    const before = listPlatforms(withTest, 'triagetest').find((p) => p.id === 'triagetest:avr');
    expect(before?.installed).toBeUndefined();
    expect(before?.versions).toContain('1.0.0');
    await installPlatform(withTest, 'triagetest:avr', '1.0.0', log);
    expect(listPlatforms(withTest).find((p) => p.id === 'triagetest:avr')?.installed).toBe('1.0.0');
    expect(listBoards(withTest).map((b) => b.fqbn)).toContain('triagetest:avr:tuno');
    const built = buildFirmware({
      setup: withTest,
      sourceDir: path.join(import.meta.dirname, 'firmware', 'BlinkSerial'),
      board: 'arduino-uno',
      fqbn: 'triagetest:avr:tuno',
      outDir: path.join(home, 'build', 'tuno'),
    });
    expect(built.fqbn).toBe('triagetest:avr:tuno');
    expect(built.flash).toBeGreaterThan(500);
  }, 300_000);
});
