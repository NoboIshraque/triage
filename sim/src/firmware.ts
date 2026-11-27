// Builds Arduino firmware for the AVR unit and for upload (ROADMAP P3-2, PA-2):
// with Triage's own Arduino engine (arduino-cli 1.6.0, Arduino's AVR platform
// and its compiler, all built from source and shipped; sim/src/arduino.ts). A
// sketch folder builds as it is; a PlatformIO-style folder (`firmware/src/main.cpp`,
// with `firmware/generated/`) builds through a generated wrapper sketch. The
// simulation and the Upload button use the same firmware.hex.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ArduinoError,
  BOARD_FQBNS,
  buildArduino,
  findArduinoEngine,
  fqbnOf,
  isSketchFolder,
  prepareArduino,
  type ArduinoDiagnostic,
  type ArduinoSetup,
} from './arduino.js';

export interface Toolchain {
  /** The Arduino engine's folder. */
  readonly root: string;
  /** Where it came from, for messages. */
  readonly source: string;
}

/** Finds Triage's Arduino engine, or says what's missing. */
export function findToolchain(): Toolchain | { missing: string } {
  const found = findArduinoEngine();
  if ('missing' in found) return found;
  return {
    root: found.root,
    source: `arduino-cli ${found.manifest.arduinoCli}, avr-gcc ${found.manifest.tools['avr-gcc'] ?? '?'} (${found.source})`,
  };
}

export interface BuildResult {
  readonly hex: string;
  readonly elf: string;
  /** Flash and RAM used, bytes. */
  readonly flash: number;
  readonly ram: number;
  /** What the board has (0 when unknown). */
  readonly maxFlash: number;
  readonly maxRam: number;
  /** Whether it was already up to date. */
  readonly cached: boolean;
  readonly toolchain: string;
  readonly fqbn: string;
  readonly libraries: readonly string[];
  /** The compiler's output and its messages, for the Output and Problems panels. */
  readonly output: string;
  readonly diagnostics: readonly ArduinoDiagnostic[];
  readonly compileCommands?: string;
}

const SOURCES = /\.(c|cpp|cc|cxx|S|ino|h|hpp)$/;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      if (!name.startsWith('.')) out.push(...files(file));
    } else if (SOURCES.test(name)) out.push(file);
  }
  return out;
}

/** The installed libraries' names and versions: a new one may change the build. */
function librariesKey(setup: ArduinoSetup): string {
  const dir = path.join(setup.userDir, 'libraries');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const props = path.join(dir, name, 'library.properties');
      const version = existsSync(props)
        ? (/^version=(.*)$/m.exec(readFileSync(props, 'utf8'))?.[1] ?? '')
        : '';
      return `${name}@${version}`;
    })
    .join(',');
}

/** Builds the sources in `sourceDir` for a board into `outDir/firmware.hex`. */
export function buildFirmware(options: {
  sourceDir: string;
  board: string;
  /** The board for arduino-cli, when the board profile's default isn't wanted. */
  fqbn?: string | undefined;
  outDir: string;
  /** Extra include folders (a project's firmware/ for "generated/…"). */
  includes?: string[];
  setup?: ArduinoSetup;
}): BuildResult {
  const setup = options.setup ?? prepareArduino();
  const fqbn = fqbnOf({ board: options.board, fqbn: options.fqbn });
  const sources = files(options.sourceDir);
  if (sources.length === 0) throw new ArduinoError(`no firmware sources in ${options.sourceDir}`);

  // Up to date when every source, header, flag, library and the engine are unchanged.
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      fqbn,
      includes: options.includes ?? [],
      engine: setup.engine.manifest.sources,
      libraries: librariesKey(setup),
      v: 3,
    }),
  );
  for (const dir of [options.sourceDir, ...(options.includes ?? [])]) {
    for (const file of files(dir)) hash.update(file).update(readFileSync(file));
  }
  const key = hash.digest('hex').slice(0, 16);
  mkdirSync(options.outDir, { recursive: true });
  const stamp = path.join(options.outDir, 'firmware.key');
  const summary = path.join(options.outDir, 'firmware.json');
  if (existsSync(stamp) && existsSync(summary) && readFileSync(stamp, 'utf8') === key) {
    const saved = JSON.parse(readFileSync(summary, 'utf8')) as Omit<BuildResult, 'cached'>;
    if (existsSync(saved.hex)) return { ...saved, cached: true };
  }

  const built = buildArduino({
    setup,
    firmwareDir: options.sourceDir,
    fqbn,
    outDir: options.outDir,
    ...(options.includes ? { includes: options.includes } : {}),
  });
  const result: Omit<BuildResult, 'cached'> = {
    hex: built.hex,
    elf: built.elf,
    flash: built.flash,
    ram: built.ram,
    maxFlash: built.maxFlash,
    maxRam: built.maxRam,
    toolchain: built.toolchain,
    fqbn,
    libraries: built.libraries,
    output: built.output,
    diagnostics: built.diagnostics,
    ...(built.compileCommands ? { compileCommands: built.compileCommands } : {}),
  };
  writeFileSync(summary, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(stamp, key);
  return { ...result, cached: false };
}

/** The folder a project's firmware builds from: a sketch folder, or its src/. */
export function firmwareSourceDir(firmwareDir: string): string {
  if (isSketchFolder(firmwareDir)) return firmwareDir;
  const src = path.join(firmwareDir, 'src');
  return existsSync(src) ? src : firmwareDir;
}

/** Builds a project's firmware into `<project>/.triage/build/<board>/`. */
export function buildProjectFirmware(project: {
  root: string;
  firmwareDir: string;
  board: string;
  fqbn?: string | undefined;
}): BuildResult {
  const fqbn = fqbnOf(project);
  const folder = fqbn === BOARD_FQBNS[project.board] ? project.board : fqbn.replace(/[:=,]/g, '_');
  return buildFirmware({
    sourceDir: firmwareSourceDir(project.firmwareDir),
    board: project.board,
    fqbn,
    outDir: path.join(project.root, '.triage', 'build', folder),
    includes: [project.firmwareDir],
  });
}
