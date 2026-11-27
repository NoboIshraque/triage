// Upload to a board without a board (ROADMAP PA-3 done-when): an emulated Uno with
// its real bootloader (Optiboot from the shipped core, sim/src/board.ts) behind a
// virtual serial port; `arduino-cli upload` (avrdude) programs it, and the
// uploaded sketch's serial output is read back (over TCP on every OS; on Linux also
// through a socat pty, the virtual serial port avrdude opens like /dev/ttyACM0). Needs Triage's Arduino engine; skipped where it's missing
// unless TRIAGE_REQUIRE_TOOLCHAIN=1 (CI). The pty part needs socat (Linux CI).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { findArduinoEngine, prepareArduino, upload } from '../src/arduino.js';
import { EmulatedBoard, serveBoard } from '../src/board.js';
import { buildFirmware } from '../src/firmware.js';
import { parseHex } from '../src/hex.js';
import { repoRoot } from './helpers.js';

const engine = findArduinoEngine();
if (process.env['TRIAGE_REQUIRE_TOOLCHAIN'] === '1' && 'missing' in engine) {
  throw new Error(engine.missing);
}
const ready = !('missing' in engine);
const socat =
  process.platform === 'linux' && spawnSync('socat', ['-V'], { encoding: 'utf8' }).status === 0;

function optiboot(): string {
  if ('missing' in engine) throw new Error(engine.missing);
  const version = engine.manifest.platform.split('@')[1] ?? '';
  return readFileSync(
    path.join(
      engine.root,
      'data/packages/arduino/hardware/avr',
      version,
      'bootloaders/optiboot/optiboot_atmega328.hex',
    ),
    'utf8',
  );
}

function build(): { hex: string; dir: string } {
  const out = path.join(repoRoot, 'build', 'sim', 'firmware', 'BlinkSerial');
  mkdirSync(out, { recursive: true });
  const result = buildFirmware({
    sourceDir: path.join(import.meta.dirname, 'firmware', 'BlinkSerial'),
    board: 'arduino-uno',
    outDir: out,
  });
  return { hex: readFileSync(result.hex, 'utf8'), dir: out };
}

/** The uploaded program is in the board's flash, byte for byte. */
function expectFlashed(board: EmulatedBoard, hex: string): void {
  const image = parseHex(hex);
  let last = image.length - 1;
  while (last > 0 && image[last] === 0xff) last--;
  expect(Buffer.from(board.flash.subarray(0, last + 1))).toEqual(
    Buffer.from(image.subarray(0, last + 1)),
  );
}

/** Reads the board's serial port until `text` arrives (a connection resets it). */
function readSerial(port: number, text: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const socket = connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `no "${text}" on the serial port within ${timeoutMs} ms; got ${JSON.stringify(seen)}`,
        ),
      );
    }, timeoutMs);
    socket.on('data', (data: Buffer) => {
      seen += data.toString('latin1');
      if (seen.includes(text)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(seen);
      }
    });
    socket.on('error', reject);
  });
}

const children: ChildProcess[] = [];
const temp = mkdtempSync(path.join(tmpdir(), 'triage-upload-'));
afterAll(() => {
  for (const child of children) child.kill();
  rmSync(temp, { recursive: true, force: true });
});

describe.skipIf(!ready)('upload to an emulated Uno (Optiboot)', () => {
  it('arduino-cli uploads Blink over the serial link, and the board runs it', async () => {
    const setup = prepareArduino();
    const firmware = build();
    const board = new EmulatedBoard({ bootloaderHex: optiboot() });
    const served = await serveBoard(board);
    try {
      let log = '';
      const started = performance.now();
      await upload(
        setup,
        {
          fqbn: 'arduino:avr:uno',
          buildDir: firmware.dir,
          port: `net:127.0.0.1:${served.port}`,
          verify: true,
        },
        (text) => (log += text),
      );
      console.log(
        `upload: ${((performance.now() - started) / 1000).toFixed(1)} s, ${board.pagesWritten} pages`,
      );
      expect(log).toMatch(/bytes of flash verified|flash verified/);
      expect(board.pagesWritten).toBeGreaterThan(0);
      expectFlashed(board, firmware.hex);
      // Opening the port resets the board; the bootloader hands over to the sketch.
      const serial = await readSerial(served.port, 'LED off');
      expect(serial).toContain('Triage blink ready');
    } finally {
      await served.close();
    }
  }, 120_000);

  it.skipIf(!socat)(
    'uploads through a virtual serial port (a pty) and reads the board on it',
    async () => {
      const setup = prepareArduino();
      const firmware = build();
      const board = new EmulatedBoard({ bootloaderHex: optiboot() });
      const served = await serveBoard(board);
      const tty = path.join(temp, 'ttyTRIAGE0');
      // A pty that connects to the board each time something opens it (DTR).
      const bridge = spawn(
        'socat',
        [
          `PTY,link=${tty},raw,echo=0,wait-slave,pty-interval=0.005`,
          `TCP:127.0.0.1:${served.port}`,
        ],
        { stdio: 'ignore' },
      );
      children.push(bridge);
      const keepBridging = () => {
        // socat ends when the port is closed; start it again for the next opener.
        const again = spawn(
          'socat',
          [
            `PTY,link=${tty},raw,echo=0,wait-slave,pty-interval=0.005`,
            `TCP:127.0.0.1:${served.port}`,
          ],
          { stdio: 'ignore' },
        );
        children.push(again);
        again.on('exit', keepBridging);
      };
      bridge.on('exit', keepBridging);
      try {
        for (let i = 0; i < 100 && !existsSync(tty); i++)
          await new Promise((r) => setTimeout(r, 50));
        let log = '';
        await upload(
          setup,
          { fqbn: 'arduino:avr:uno', buildDir: firmware.dir, port: tty },
          (text) => (log += text),
        );
        expect(log).toMatch(/bytes of flash written/);
        expectFlashed(board, firmware.hex);
        for (let i = 0; i < 100 && !existsSync(tty); i++)
          await new Promise((r) => setTimeout(r, 50));
        // Opening the port resets the board (socat connects, as DTR would). arduino-cli's
        // serial-monitor can't open a pty (it reads the modem lines, which a pty lacks:
        // "inappropriate ioctl for device"), so the sketch's output is read here directly;
        // the Serial Monitor itself is the owner's check on a real board (CHECKS C8).
        const seen = await new Promise<string>((resolve, reject) => {
          let text = '';
          const stream = createReadStream(tty);
          const timer = setTimeout(() => {
            stream.destroy();
            reject(new Error(`the virtual port gave ${JSON.stringify(text)}`));
          }, 20_000);
          stream.on('data', (data) => {
            text += Buffer.from(data).toString('latin1');
            if (text.includes('LED off')) {
              clearTimeout(timer);
              stream.destroy();
              resolve(text);
            }
          });
          stream.on('error', reject);
        });
        expect(seen).toContain('LED on');
      } finally {
        bridge.removeAllListeners('exit');
        for (const child of children) {
          child.removeAllListeners('exit');
          child.kill();
        }
        await served.close();
      }
    },
    120_000,
  );
});
