// Triage's Arduino engine (ROADMAP PA-2, ADR 0006): arduino-cli 1.6.0 and the AVR
// toolchain, built from source by engines/arduino/build.mjs and shipped with the
// app. This module finds the engine, gives it the user's own Arduino folder
// (seeded from the engine's data folder on first use), and runs arduino-cli for
// builds, uploads, boards, libraries and examples. The app's Arduino engine
// (vs/triage/node/arduinoEngineMain), the `triage` CLI and the tests use it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const hostOs =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

/** The engine's manifest (engines/arduino/build.mjs writes triage-arduino.json). */
export interface ArduinoManifest {
  readonly os: string;
  readonly arduinoCli: string;
  readonly platform: string;
  readonly tools: Readonly<Record<string, string>>;
  readonly sources: string;
}

export interface ArduinoEngine {
  /** The engine folder (bin/, data/, triage-arduino.json). */
  readonly root: string;
  readonly cli: string;
  readonly manifest: ArduinoManifest;
  /** Where it was found, for messages. */
  readonly source: string;
}

/**
 * Finds the Arduino engine: TRIAGE_ARDUINO (an engine folder), the one the app
 * ships beside the sim package (resources/app/engines/arduino), then the one
 * engines/arduino/build.mjs staged in this repository.
 */
export function findArduinoEngine(): ArduinoEngine | { missing: string } {
  const candidates: [string, string][] = [];
  if (process.env['TRIAGE_ARDUINO'])
    candidates.push([process.env['TRIAGE_ARDUINO'], 'TRIAGE_ARDUINO']);
  candidates.push([path.resolve(import.meta.dirname, '..', '..', 'arduino'), 'Triage (bundled)']);
  candidates.push([
    path.join(repoRoot, 'engines', 'arduino', 'build', hostOs, 'stage'),
    'engines/arduino',
  ]);
  for (const [root, source] of candidates) {
    const cli = path.join(root, 'bin', `arduino-cli${exe}`);
    const manifestFile = path.join(root, 'triage-arduino.json');
    if (existsSync(cli) && existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ArduinoManifest;
      return { root, cli, manifest, source };
    }
  }
  return {
    missing:
      "Triage's Arduino engine (arduino-cli and the AVR compiler) was not found. It ships with Triage; " +
      'in a source checkout, build it with `node engines/arduino/build.mjs` (Linux) or take it from the ' +
      'Arduino workflow (engines/arduino/README.md), or set TRIAGE_ARDUINO',
  };
}

/** The user's own Arduino folder: data (platforms, tools), sketchbook (libraries). */
export function arduinoHome(): string {
  if (process.env['TRIAGE_ARDUINO_HOME']) return process.env['TRIAGE_ARDUINO_HOME'];
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
    return path.join(local, 'Triage', 'Arduino');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Triage', 'Arduino');
  }
  const data = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share');
  return path.join(data, 'triage', 'arduino');
}

export interface ArduinoSetup {
  readonly engine: ArduinoEngine;
  readonly home: string;
  /** arduino-cli's data folder: packages/, the indexes, staging/. */
  readonly dataDir: string;
  /** arduino-cli's user folder (the sketchbook): libraries/, hardware/. */
  readonly userDir: string;
  /** The environment arduino-cli runs with (its settings as variables). */
  readonly env: NodeJS.ProcessEnv;
}

const SEED_STAMP = '.triage-seed.json';

/**
 * Prepares the user's Arduino folder from the engine: the first time, and after
 * Triage's engine changes, its data folder (the AVR platform and tools, the empty
 * indexes) is copied in. Platforms and libraries the user installed stay.
 */
export function prepareArduino(engine?: ArduinoEngine): ArduinoSetup {
  const found = engine ?? findArduinoEngine();
  if ('missing' in found) throw new Error(found.missing);
  const home = arduinoHome();
  const dataDir = path.join(home, 'data');
  const userDir = path.join(home, 'sketchbook');
  const stampFile = path.join(dataDir, SEED_STAMP);
  const stamp = JSON.stringify({ sources: found.manifest.sources, tools: found.manifest.tools });
  const seeded = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : undefined;
  if (seeded !== stamp) seed(path.join(found.root, 'data'), dataDir, seeded === undefined);
  writeFileSync(stampFile, stamp);
  mkdirSync(path.join(userDir, 'libraries'), { recursive: true });
  return {
    engine: found,
    home,
    dataDir,
    userDir,
    env: {
      ...process.env,
      ARDUINO_DIRECTORIES_DATA: dataDir,
      ARDUINO_DIRECTORIES_USER: userDir,
      ARDUINO_DIRECTORIES_DOWNLOADS: path.join(home, 'downloads'),
      ARDUINO_BUILD_CACHE_PATH: path.join(home, 'build-cache'),
      ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false',
      // Triage reads arduino-cli's output; its messages are in English.
      ARDUINO_LOCALE: 'en',
    },
  };
}

/** Copies the engine's packages in; the indexes only where the user has none yet. */
function seed(from: string, to: string, first: boolean): void {
  mkdirSync(to, { recursive: true });
  const packages = path.join(from, 'packages');
  // Each shipped platform and tool replaces the same version in the user's folder.
  for (const packager of readdirSync(packages)) {
    for (const kind of ['hardware', 'tools']) {
      const kindDir = path.join(packages, packager, kind);
      if (!existsSync(kindDir)) continue;
      for (const name of readdirSync(kindDir)) {
        for (const version of readdirSync(path.join(kindDir, name))) {
          const target = path.join(to, 'packages', packager, kind, name, version);
          const temp = `${target}.triage-new`;
          rmSync(temp, { recursive: true, force: true });
          cpSync(path.join(kindDir, name, version), temp, { recursive: true });
          rmSync(target, { recursive: true, force: true });
          renameSync(temp, target);
        }
      }
    }
  }
  for (const index of ['package_index.json', 'library_index.json']) {
    if (first || !existsSync(path.join(to, index))) {
      cpSync(path.join(from, index), path.join(to, index));
    }
  }
}

// --- running arduino-cli ---------------------------------------------------------------

export class ArduinoError extends Error {
  constructor(
    message: string,
    readonly output = '',
  ) {
    super(message);
  }
}

/** Runs arduino-cli and returns its JSON answer (`--format json`). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- callers name the JSON's shape
export function cliJson<T = unknown>(setup: ArduinoSetup, args: readonly string[]): T {
  const result = spawnSync(setup.engine.cli, [...args, '--format', 'json'], {
    env: setup.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new ArduinoError(`could not run arduino-cli: ${result.error.message}`);
  const text = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  if (result.status !== 0) {
    const error = (parsed as { error?: string } | undefined)?.error;
    throw new ArduinoError(
      plainError(error ?? (result.stderr || text || `arduino-cli ${args[0] ?? ''} failed`)),
      `${result.stderr}\n${text}`,
    );
  }
  if (parsed === undefined)
    throw new ArduinoError(`arduino-cli ${args.join(' ')}: not JSON:\n${text}`);
  return parsed as T;
}

/** Runs arduino-cli, streaming its text output (installs, uploads). */
export function cliStream(
  setup: ArduinoSetup,
  args: readonly string[],
  onOutput: (text: string) => void,
): { process: ChildProcess; done: Promise<void> } {
  const child = spawn(setup.engine.cli, args, { env: setup.env, windowsHide: true });
  let all = '';
  const take = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    all += text;
    onOutput(text);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      reject(new ArduinoError(`could not run arduino-cli: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ArduinoError(plainError(lastLines(all)), all));
    });
  });
  return { process: child, done };
}

function lastLines(text: string): string {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-4).join('\n') || 'arduino-cli failed';
}

/** arduino-cli's messages, in the plain words Triage's panels show. */
export function plainError(message: string): string {
  const text = message.trim();
  if (/no upload port provided|port not found|no such file or directory.*(tty|COM)/i.test(text)) {
    return 'The board was not found on that port. Check the USB cable, pick the port again, and close other programs using it (another serial monitor).';
  }
  if (/stk500_getsync|not in sync|programmer is not responding/i.test(text)) {
    return 'The board did not answer the upload. Check the board type (Tools: a Nano clone often needs "ATmega328P (Old Bootloader)"), the port, and that nothing else uses the port.';
  }
  if (/access is denied|permission denied/i.test(text)) {
    return 'The port is busy or not allowed: close other programs using it (a serial monitor). On Linux, add yourself to the "dialout" group.';
  }
  if (/sketch too big|text section exceeds available space/i.test(text)) {
    return 'The program is too big for this board: it uses more flash memory than the board has.';
  }
  return text;
}

// --- boards ----------------------------------------------------------------------------

/** Board profiles Triage simulates, and the board each one is for upload. */
export const BOARD_FQBNS: Readonly<Record<string, string>> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'arduino-mega': 'arduino:avr:mega:cpu=atmega2560',
};

/** The board (FQBN) a project builds for: `firmware.fqbn`, else its board profile's. */
export function fqbnOf(project: { board: string; fqbn?: string | undefined }): string {
  if (project.fqbn) return project.fqbn;
  const fqbn = BOARD_FQBNS[project.board];
  if (!fqbn) {
    throw new ArduinoError(
      `triage.toml names board "${project.board}", which Triage can't build for yet; set firmware.fqbn (for example "arduino:avr:uno")`,
    );
  }
  return fqbn;
}

/** The simulation's board profile for a board (FQBN), if Triage simulates it. */
export function simulatedProfile(fqbn: string): string | undefined {
  const base = fqbn.split(':').slice(0, 3).join(':');
  if (base === 'arduino:avr:uno') return 'arduino-uno';
  if (base === 'arduino:avr:nano') return 'arduino-nano';
  return undefined;
}

// --- building --------------------------------------------------------------------------

export interface ArduinoBuild {
  readonly hex: string;
  readonly elf: string;
  /** Flash and RAM used, bytes, and what the board has. */
  readonly flash: number;
  readonly ram: number;
  readonly maxFlash: number;
  readonly maxRam: number;
  readonly fqbn: string;
  /** The libraries the build used ("Wire 1.0", "Adafruit SSD1306 2.5.13"). */
  readonly libraries: readonly string[];
  /** What the compiler said (warnings, errors). */
  readonly output: string;
  readonly diagnostics: readonly ArduinoDiagnostic[];
  /** compile_commands.json for C++ language servers (paths are the project's own). */
  readonly compileCommands?: string;
  readonly toolchain: string;
}

export interface ArduinoDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly severity: 'error' | 'warning' | 'note';
  readonly message: string;
}

interface CompileJson {
  readonly compiler_out?: string;
  readonly compiler_err?: string;
  readonly success?: boolean;
  readonly builder_result?: {
    readonly build_path?: string;
    readonly used_libraries?: { name: string; version?: string }[];
    readonly executable_sections_size?: { name: string; size?: number; max_size?: number }[];
    readonly diagnostics?: {
      severity?: string;
      message?: string;
      file?: string;
      line?: number;
      column?: number;
    }[];
  };
  readonly error?: string;
}

const SOURCE = /\.(c|cpp|cc|cxx|S)$/;

function filesIn(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      if (!name.startsWith('.') && name !== 'examples') out.push(...filesIn(file, pattern));
    } else if (pattern.test(name)) out.push(file);
  }
  return out;
}

/** Whether `dir` is an Arduino sketch folder (it holds `<folder>.ino`). */
export function isSketchFolder(dir: string): boolean {
  return existsSync(path.join(dir, `${path.basename(dir)}.ino`));
}

/**
 * The sketch arduino-cli compiles for a firmware folder. An Arduino sketch folder
 * compiles as it is. A PlatformIO-style one (`src/main.cpp`, Triage's projects)
 * gets a generated wrapper sketch: one file per source that includes the real one
 * by its absolute path, so relative includes (`../generated/board_pins.h`),
 * library detection and the compiler's messages all point at the project's files.
 */
export function sketchFor(firmwareDir: string, buildDir: string): string {
  if (isSketchFolder(firmwareDir)) return firmwareDir;
  const src = existsSync(path.join(firmwareDir, 'src'))
    ? path.join(firmwareDir, 'src')
    : firmwareDir;
  const sources = filesIn(src, SOURCE).concat(filesIn(src, /\.ino$/));
  if (sources.length === 0) throw new ArduinoError(`no firmware sources in ${src}`);
  const name = 'firmware';
  const sketch = path.join(buildDir, 'sketch', name);
  rmSync(sketch, { recursive: true, force: true });
  mkdirSync(path.join(sketch, 'src'), { recursive: true });
  writeFileSync(
    path.join(sketch, `${name}.ino`),
    `// Generated by Triage: builds ${src} with arduino-cli. Edit those files, not this one.\n`,
  );
  for (const file of sources) {
    const relative = path.relative(src, file);
    const flat = relative.split(path.sep).join('__');
    const ext = path.extname(file) === '.ino' ? '.cpp' : path.extname(file);
    const real = file.split(path.sep).join('/');
    const prelude = file.endsWith('.ino') ? '#include <Arduino.h>\n' : '';
    writeFileSync(
      path.join(sketch, 'src', flat.replace(/\.[^.]+$/, ext)),
      `${prelude}#include "${real}"\n`,
    );
  }
  return sketch;
}

/**
 * Builds a firmware folder for a board with arduino-cli, into `outDir`:
 * firmware.hex and firmware.elf (the simulation and the upload use the same).
 */
export function buildArduino(options: {
  setup?: ArduinoSetup;
  firmwareDir: string;
  fqbn: string;
  outDir: string;
  /** Extra include folders. */
  includes?: readonly string[];
}): ArduinoBuild {
  const setup = options.setup ?? prepareArduino();
  const outDir = path.resolve(options.outDir);
  const buildPath = path.join(outDir, 'arduino');
  mkdirSync(buildPath, { recursive: true });
  const sketch = sketchFor(path.resolve(options.firmwareDir), outDir);
  const includes = (options.includes ?? []).map((i) => path.resolve(i));
  const args = [
    'compile',
    '--fqbn',
    options.fqbn,
    '--build-path',
    buildPath,
    '--output-dir',
    outDir,
    '--warnings',
    'default',
  ];
  if (includes.length > 0) {
    const flags = includes.map((i) => `"-I${i.split(path.sep).join('/')}"`).join(' ');
    args.push('--build-property', `compiler.cpp.extra_flags=${flags}`);
    args.push('--build-property', `compiler.c.extra_flags=${flags}`);
  }
  args.push(sketch);
  let result: CompileJson;
  try {
    result = cliJson<CompileJson>(setup, args);
  } catch (error) {
    if (error instanceof ArduinoError) {
      const parsed = parseCompileError(error.output);
      throw new ArduinoError(parsed ?? error.message, error.output);
    }
    throw error;
  }
  const base = path.basename(sketch);
  const hex = path.join(outDir, 'firmware.hex');
  const elf = path.join(outDir, 'firmware.elf');
  const builtHex = path.join(outDir, `${base}.ino.hex`);
  if (!existsSync(builtHex)) throw new ArduinoError(`the build made no ${builtHex}`);
  cpSync(builtHex, hex);
  if (existsSync(path.join(outDir, `${base}.ino.elf`))) {
    cpSync(path.join(outDir, `${base}.ino.elf`), elf);
  }
  const sections = result.builder_result?.executable_sections_size ?? [];
  const section = (name: string) => sections.find((s) => s.name === name);
  const output = `${result.compiler_out ?? ''}${result.compiler_err ?? ''}`;
  const severityOf = (value: string | undefined): ArduinoDiagnostic['severity'] => {
    const v = value?.toLowerCase();
    return v === 'error' ? 'error' : v === 'warning' ? 'warning' : 'note';
  };
  const diagnostics = (result.builder_result?.diagnostics ?? []).map((d): ArduinoDiagnostic => ({
    file: d.file ?? '',
    line: d.line ?? 0,
    column: d.column ?? 0,
    severity: severityOf(d.severity),
    message: d.message ?? '',
  }));
  const compileCommands = projectCompileCommands(buildPath, outDir);
  return {
    hex,
    elf,
    flash: section('text')?.size ?? 0,
    maxFlash: section('text')?.max_size ?? 0,
    ram: section('data')?.size ?? 0,
    maxRam: section('data')?.max_size ?? 0,
    fqbn: options.fqbn,
    libraries: (result.builder_result?.used_libraries ?? []).map((l) =>
      l.version ? `${l.name} ${l.version}` : l.name,
    ),
    output,
    diagnostics,
    ...(compileCommands ? { compileCommands } : {}),
    toolchain: `arduino-cli ${setup.engine.manifest.arduinoCli}, avr-gcc ${setup.engine.manifest.tools['avr-gcc'] ?? '?'} (${setup.engine.source})`,
  };
}

function parseCompileError(output: string): string | undefined {
  // The compiler's first error, as "file:line: message".
  const match = /^(.*?):(\d+):(?:\d+:)? (?:fatal )?error: (.*)$/m.exec(output);
  if (match) return `${path.basename(match[1] ?? '')}:${match[2]}: ${match[3]}`;
  try {
    const parsed = JSON.parse(output.slice(output.indexOf('{'))) as CompileJson;
    const err = parsed.compiler_err ?? parsed.error;
    if (err) {
      const m = /^(.*?):(\d+):(?:\d+:)? (?:fatal )?error: (.*)$/m.exec(err);
      return m ? `${path.basename(m[1] ?? '')}:${m[2]}: ${m[3]}` : plainError(err);
    }
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * arduino-cli's compile_commands.json, with the wrapper files replaced by the
 * project's own, copied to `<outDir>/compile_commands.json` for clangd and cpptools.
 */
function projectCompileCommands(buildPath: string, outDir: string): string | undefined {
  const file = path.join(buildPath, 'compile_commands.json');
  if (!existsSync(file)) return undefined;
  try {
    const entries = JSON.parse(readFileSync(file, 'utf8')) as { file: string; directory: string }[];
    for (const entry of entries) {
      const source = path.isAbsolute(entry.file)
        ? entry.file
        : path.join(entry.directory, entry.file);
      if (!existsSync(source)) continue;
      const text = readFileSync(source, 'utf8');
      // The copy arduino-cli compiles: `#line 1 "<wrapper>"`, then the wrapper.
      const m = /^(?:#line \d+ ".*"\n)?(?:#include <Arduino\.h>\n)?#include "(.+)"\n$/.exec(text);
      if (m?.[1] && existsSync(m[1])) entry.file = m[1];
    }
    const out = path.join(outDir, 'compile_commands.json');
    writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
    return out;
  } catch {
    return undefined;
  }
}
