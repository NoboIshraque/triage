// Builds Arduino firmware for the AVR unit (ROADMAP P3-2): avr-gcc with the
// flags of Arduino's own AVR platform (platform.txt), the Arduino core, the
// board's pin variant, and the core libraries a sketch includes (Wire, SPI,
// EEPROM, SoftwareSerial). Sources are every .c/.cpp/.S/.ino file of a folder
// (a sketch, or a PlatformIO-style src/), so `firmware/src/main.cpp` builds as is.
//
// The toolchain is found in this order: TRIAGE_AVR_GCC (its bin folder), avr-gcc
// on PATH, then the one the Arduino IDE or arduino-cli installs (Arduino15). The
// core: TRIAGE_ARDUINO_AVR, the one Arduino15 holds, then Triage's pinned checkout
// (engines/arduino-avr, `node scripts/forks/fetch.mjs`-style fetch).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { board as boardProfile } from './boards.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';

export interface Toolchain {
  /** Folder with avr-gcc, avr-g++, avr-ar, avr-objcopy. */
  readonly bin: string;
  /** The Arduino AVR core: cores/, variants/, libraries/. */
  readonly core: string;
  /** Where each came from, for messages. */
  readonly source: string;
}

function arduino15(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
    return [path.join(local, 'Arduino15')];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Arduino15')];
  return [path.join(home, '.arduino15')];
}

/** Version folders under `dir`, newest first. */
function versions(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((v) => statSync(path.join(dir, v)).isDirectory())
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((v) => path.join(dir, v));
}

function onPath(program: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, program + exe))) return dir;
  }
  return undefined;
}

/** Finds avr-gcc and the Arduino AVR core, or says what's missing. */
export function findToolchain(): Toolchain | { missing: string } {
  const bins: [string, string][] = [];
  if (process.env['TRIAGE_AVR_GCC']) bins.push([process.env['TRIAGE_AVR_GCC'], 'TRIAGE_AVR_GCC']);
  const pathBin = onPath('avr-gcc');
  if (pathBin) bins.push([pathBin, 'PATH']);
  for (const root of arduino15()) {
    for (const v of versions(path.join(root, 'packages', 'arduino', 'tools', 'avr-gcc'))) {
      bins.push([path.join(v, 'bin'), `Arduino15 (${path.basename(v)})`]);
    }
  }
  const bin = bins.find(([dir]) => existsSync(path.join(dir, `avr-gcc${exe}`)));

  const cores: [string, string][] = [];
  if (process.env['TRIAGE_ARDUINO_AVR'])
    cores.push([process.env['TRIAGE_ARDUINO_AVR'], 'TRIAGE_ARDUINO_AVR']);
  for (const root of arduino15()) {
    for (const v of versions(path.join(root, 'packages', 'arduino', 'hardware', 'avr'))) {
      cores.push([v, `Arduino15 core ${path.basename(v)}`]);
    }
  }
  // In the packaged app, the core ships beside the sim package (app/build.mjs engines).
  cores.push([path.join(import.meta.dirname, '..', 'arduino-avr'), 'Triage (bundled)']);
  cores.push([path.join(repoRoot, 'engines', 'arduino-avr', 'upstream'), 'engines/arduino-avr']);
  const core = cores.find(([dir]) => existsSync(path.join(dir, 'cores', 'arduino', 'Arduino.h')));

  if (!bin || !core) {
    const what = [!bin && 'avr-gcc', !core && 'the Arduino AVR core'].filter(Boolean).join(' and ');
    return {
      missing: `${what} not found. Install the Arduino IDE 2 or arduino-cli and run \`arduino-cli core install arduino:avr\` (Triage then uses its compiler), or put avr-gcc on PATH`,
    };
  }
  return { bin: bin[0], core: core[0], source: `${bin[1]}; ${core[1]}` };
}

export interface BuildResult {
  readonly hex: string;
  readonly elf: string;
  /** Flash and RAM used, bytes. */
  readonly flash: number;
  readonly ram: number;
  /** Whether it was already up to date. */
  readonly cached: boolean;
  readonly toolchain: string;
}

const LIBRARIES = ['Wire', 'SPI', 'EEPROM', 'SoftwareSerial'];

function sourcesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      if (!name.startsWith('.') && name !== 'examples') out.push(...sourcesIn(file));
    } else if (/\.(c|cpp|S|ino)$/.test(name)) out.push(file);
  }
  return out.sort();
}

function run(program: string, args: string[], cwd: string): void {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`could not run ${program}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(program)} failed:\n${(result.stderr || result.stdout).trim()}`,
    );
  }
}

/** Builds the sources in `sourceDir` for a board into `outDir/firmware.hex`. */
export function buildFirmware(options: {
  sourceDir: string;
  board: string;
  outDir: string;
  /** Extra include folders (a project's firmware/ for "../generated/…"). */
  includes?: string[];
}): BuildResult {
  const found = findToolchain();
  if ('missing' in found) throw new Error(found.missing);
  const profile = boardProfile(options.board);
  const variant = options.board === 'arduino-nano' ? 'eightanaloginputs' : 'standard';
  const define = options.board === 'arduino-nano' ? 'ARDUINO_AVR_NANO' : 'ARDUINO_AVR_UNO';
  const tool = (name: string) => path.join(found.bin, `${name}${exe}`);
  const sources = sourcesIn(options.sourceDir);
  if (sources.length === 0) throw new Error(`no firmware sources in ${options.sourceDir}`);

  // Core libraries the sketch includes.
  const text = sources.map((s) => readFileSync(s, 'utf8')).join('\n');
  const libraries = LIBRARIES.filter((lib) =>
    new RegExp(`#include\\s*[<"]${lib}\\.h[>"]`).test(text),
  ).map((lib) => path.join(found.core, 'libraries', lib, 'src'));
  const includes = [
    path.join(found.core, 'cores', 'arduino'),
    path.join(found.core, 'variants', variant),
    ...libraries,
    ...libraries.map((l) => path.join(l, 'utility')),
    ...(options.includes ?? []),
  ];
  const common = [
    `-mmcu=${profile.mcu}`,
    `-DF_CPU=${profile.frequency}L`,
    '-DARDUINO=10819',
    `-D${define}`,
    '-DARDUINO_ARCH_AVR',
    ...includes.map((i) => `-I${i}`),
  ];
  const all = [
    ...sources.map((s) => ({ file: s, group: 'sketch' })),
    ...sourcesIn(path.join(found.core, 'cores', 'arduino')).map((s) => ({
      file: s,
      group: 'core',
    })),
    ...libraries.flatMap((l) => sourcesIn(l).map((s) => ({ file: s, group: 'lib' }))),
  ];

  // Cache key: every source's text, the flags and the toolchain.
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ common, toolchain: found.source, v: 2 }));
  for (const { file } of all) hash.update(file).update(readFileSync(file));
  for (const dir of options.includes ?? []) {
    for (const file of sourcesIn(dir).concat(
      existsSync(dir)
        ? readdirSync(dir, { recursive: true })
            .map(String)
            .filter((f) => f.endsWith('.h'))
            .map((f) => path.join(dir, f))
        : [],
    )) {
      if (existsSync(file) && statSync(file).isFile()) hash.update(file).update(readFileSync(file));
    }
  }
  const key = hash.digest('hex').slice(0, 16);
  mkdirSync(options.outDir, { recursive: true });
  const hex = path.join(options.outDir, 'firmware.hex');
  const elf = path.join(options.outDir, 'firmware.elf');
  const stamp = path.join(options.outDir, 'firmware.key');
  if (existsSync(hex) && existsSync(stamp) && readFileSync(stamp, 'utf8') === key) {
    return { hex, elf, ...sizes(tool('avr-size'), elf), cached: true, toolchain: found.source };
  }

  const objects: string[] = [];
  const objDir = path.join(options.outDir, 'obj');
  mkdirSync(objDir, { recursive: true });
  for (const [i, { file, group }] of all.entries()) {
    const object = path.join(objDir, `${group}-${i}-${path.basename(file)}.o`);
    const cpp = /\.(cpp|ino)$/.test(file);
    const asm = file.endsWith('.S');
    const flags = asm
      ? ['-c', '-g', '-x', 'assembler-with-cpp']
      : cpp
        ? [
            '-c',
            '-g',
            '-Os',
            '-w',
            '-std=gnu++11',
            '-fpermissive',
            '-fno-exceptions',
            '-ffunction-sections',
            '-fdata-sections',
            '-fno-threadsafe-statics',
            '-Wno-error=narrowing',
          ]
        : ['-c', '-g', '-Os', '-w', '-std=gnu11', '-ffunction-sections', '-fdata-sections'];
    const extra = file.endsWith('.ino') ? ['-x', 'c++', '-include', 'Arduino.h'] : [];
    run(
      tool(cpp ? 'avr-g++' : 'avr-gcc'),
      [...flags, ...extra, ...common, file, '-o', object],
      options.outDir,
    );
    objects.push(object);
  }
  run(
    tool('avr-gcc'),
    ['-w', '-Os', '-g', '-Wl,--gc-sections', `-mmcu=${profile.mcu}`, '-o', elf, ...objects, '-lm'],
    options.outDir,
  );
  run(tool('avr-objcopy'), ['-O', 'ihex', '-R', '.eeprom', elf, hex], options.outDir);
  writeFileSync(stamp, key);
  return { hex, elf, ...sizes(tool('avr-size'), elf), cached: false, toolchain: found.source };
}

function sizes(avrSize: string, elf: string): { flash: number; ram: number } {
  const result = spawnSync(avrSize, ['-A', elf], { encoding: 'utf8' });
  const section = (name: string) =>
    Number(new RegExp(`^\\${name}\\s+(\\d+)`, 'm').exec(result.stdout)?.[1] ?? 0);
  return { flash: section('.text') + section('.data'), ram: section('.data') + section('.bss') };
}

/** Builds a project's firmware into `<project>/.triage/build/<board>/`. */
export function buildProjectFirmware(project: {
  root: string;
  firmwareDir: string;
  board: string;
}): BuildResult {
  const src = path.join(project.firmwareDir, 'src');
  return buildFirmware({
    sourceDir: existsSync(src) ? src : project.firmwareDir,
    board: project.board,
    outDir: path.join(project.root, '.triage', 'build', project.board),
    includes: [project.firmwareDir],
  });
}
