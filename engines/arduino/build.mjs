#!/usr/bin/env node
// Builds Triage's Arduino engine from source (ROADMAP PA-2, ADR 0006): arduino-cli
// and its helper tools (Go), ctags (C), avrdude (C, CMake) and the AVR compiler
// (Atmel's binutils 2.26, GNU GCC 7.3.0 with Atmel's patches, avr-libc 2.0.0: the
// recipe of Arduino's own 7.3.0-atmel3.6.1-arduino7), for Linux and Windows (x64).
// Every source is pinned in upstream.json (tag + commit, or SHA-256); nothing
// prebuilt is downloaded.
//
//   node engines/arduino/build.mjs                    every step, for this OS
//   node engines/arduino/build.mjs --os linux,windows both (Windows is cross-built)
//   node engines/arduino/build.mjs fetch tools stage  just those steps
//   node engines/arduino/build.mjs verify             compile Blink with the stage
//
// Runs on Linux. The Windows engine is cross-built there with mingw-w64, as Arduino
// builds its own Windows toolchain (a Canadian cross for GCC); a Windows machine
// takes the result from CI (the Arduino workflow). Needs: git, curl, tar, unzip,
// make, a C/C++ compiler, CMake, Ninja, flex, bison, autoconf, automake, Go (or an
// older Go to build the pinned one), and for Windows the mingw-w64 cross compilers.
//
// Output: engines/arduino/build/<os>/stage/
//   bin/arduino-cli(.exe)
//   data/packages/arduino/hardware/avr/1.8.8/        the pinned core + installed.json
//   data/packages/arduino/tools/{avr-gcc,avrdude,arduinoOTA}/<version>/
//   data/packages/builtin/tools/{ctags,serial-discovery,serial-monitor,mdns-discovery}/<version>/
//   data/package_index.json, data/library_index.json  empty until the user refreshes them
//   examples/                                         the Arduino IDE's built-in examples
//   triage-arduino.json                                 what was built, from which sources
// The app copies the stage into resources/app/engines/arduino/; on first use the
// data folder is copied to the user's own Arduino folder (sim/src/arduino.ts).
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fetchPin } from '../../scripts/forks/fetch.mjs';
import { ForkError, isWindows, main, run, withRetries } from '../../scripts/forks/lib.mjs';

const dir = import.meta.dirname;
const repoRoot = path.resolve(dir, '..', '..');
const pins = JSON.parse(readFileSync(path.join(dir, 'upstream.json'), 'utf8'));
const upstreamDir = path.join(dir, 'upstream');
const downloads = path.join(upstreamDir, 'downloads');
// TRIAGE_ARDUINO_BUILD_DIR moves the build (and its stages) elsewhere.
const buildRoot = process.env.TRIAGE_ARDUINO_BUILD_DIR
  ? path.resolve(process.env.TRIAGE_ARDUINO_BUILD_DIR)
  : path.join(dir, 'build');
const hostOs = isWindows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const MINGW = 'x86_64-w64-mingw32';

export const stageDir = (target = hostOs) => path.join(buildRoot, target, 'stage');

const STEPS = ['fetch', 'go', 'tools', 'toolchain', 'stage', 'verify'];

// --- helpers ---------------------------------------------------------------------

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** A stamp file records what a step built; the step is skipped while it matches. */
function stamped(file, key, fn) {
  if (existsSync(file) && readFileSync(file, 'utf8') === key) return false;
  fn();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key);
  return true;
}

function keyOf(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

/** Bash for configure/make (POSIX tools; the build runs on Linux). */
function sh(script, cwd, env = {}) {
  run('bash', ['-eo', 'pipefail', '-c', script], { cwd, env });
}

function jobs() {
  return String(Math.max(1, os.availableParallelism()));
}

/** Downloads a pinned tarball into upstream/downloads/ and checks its SHA-256. */
function download({ url, sha256: expected }) {
  mkdirSync(downloads, { recursive: true });
  const file = path.join(downloads, path.basename(new URL(url).pathname));
  if (existsSync(file) && sha256(file) === expected) return file;
  rmSync(file, { force: true });
  withRetries(`download ${url}`, () =>
    run('curl', ['-sSfL', '--retry', '3', '-o', `${file}.part`, url]),
  );
  const actual = sha256(`${file}.part`);
  if (actual !== expected) {
    rmSync(`${file}.part`, { force: true });
    throw new ForkError(`${url}: SHA-256 ${actual}, but upstream.json pins ${expected}`);
  }
  cpSync(`${file}.part`, file);
  rmSync(`${file}.part`, { force: true });
  return file;
}

/** A fresh copy of a source folder for one target's build (sources stay clean). */
function freshCopy(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
  return target;
}

function exeOf(target) {
  return target === 'windows' ? '.exe' : '';
}

// --- fetch ------------------------------------------------------------------------

const gitSources = () => ({
  'arduino-cli': pins.arduinoCli,
  ...Object.fromEntries(pins.goTools.map((tool) => [tool.name, tool])),
  ctags: pins.ctags,
  'arduino-examples': pins.examples,
  avrdude: pins.avrdude,
  'avrdude-packing': pins.avrdudePacking,
  'toolchain-avr': pins.avrGcc.toolchainAvr,
});

function fetchAll() {
  for (const [name, pin] of Object.entries(gitSources())) {
    fetchPin(pin, path.join(upstreamDir, name), { label: `engines/arduino/upstream/${name}` });
  }
  for (const tarball of Object.values(pins.avrGcc.tarballs)) download(tarball);
  // The Arduino AVR core ships as the platform (engines/arduino-avr).
  run(process.execPath, [path.join(repoRoot, 'engines', 'arduino-avr', 'fetch.mjs')]);
}

// --- Go ---------------------------------------------------------------------------

function goVersionOf(go) {
  let result;
  try {
    result = run(go, ['env', 'GOVERSION'], { capture: true, allowFailure: true });
  } catch {
    return undefined; // not installed
  }
  const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function atLeast(version, minimum) {
  const want = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((version[i] ?? 0) !== (want[i] ?? 0)) return (version[i] ?? 0) > (want[i] ?? 0);
  }
  return true;
}

/** A Go new enough for arduino-cli: the one on PATH, or the pinned one built from source. */
function ensureGo() {
  const built = path.join(buildRoot, 'go', 'bin', `go${isWindows ? '.exe' : ''}`);
  for (const go of [built, 'go']) {
    const version = goVersionOf(go);
    if (version && atLeast(version, pins.go.minimum)) return go;
  }
  const bootstrap = goVersionOf('go');
  if (!bootstrap) {
    throw new ForkError(
      `arduino-cli needs Go ${pins.go.minimum} or later, and no Go is on PATH to build it with`,
    );
  }
  console.log(`Building Go ${pins.go.version} from source with Go ${bootstrap.join('.')} …`);
  const tarball = download(pins.go);
  const goRoot = path.join(buildRoot, 'go');
  rmSync(goRoot, { recursive: true, force: true });
  mkdirSync(buildRoot, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', buildRoot]);
  const bootstrapRoot = run('go', ['env', 'GOROOT'], { capture: true }).stdout.trim();
  sh('./make.bash', path.join(goRoot, 'src'), {
    GOROOT_BOOTSTRAP: bootstrapRoot,
    GOTOOLCHAIN: 'local',
  });
  return built;
}

// --- tools: arduino-cli, the builtin tools, ctags, avrdude --------------------------

function goBuild(go, source, target, output, ldflags) {
  const cwd = path.join(upstreamDir, source);
  if (!existsSync(path.join(cwd, 'go.mod'))) {
    // arduinoOTA 1.3.0 predates Go modules (standard library only).
    run(go, ['mod', 'init', `github.com/arduino/${source}`], { cwd });
  }
  run(go, ['build', '-trimpath', '-ldflags', `-s -w ${ldflags}`, '-o', output, '.'], {
    cwd,
    env: {
      GOOS: target,
      GOARCH: 'amd64',
      CGO_ENABLED: '0',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-mod=mod',
    },
  });
}

function buildTools(target) {
  const out = path.join(buildRoot, target, 'tools');
  const exe = exeOf(target);
  const go = ensureGo();
  const cli = pins.arduinoCli;
  stamped(path.join(out, '.arduino-cli'), keyOf(cli, 1), () =>
    goBuild(
      go,
      'arduino-cli',
      target,
      path.join(out, 'arduino-cli', `arduino-cli${exe}`),
      `-X github.com/arduino/arduino-cli/internal/version.versionString=${cli.version} ` +
        `-X github.com/arduino/arduino-cli/internal/version.commit=${cli.commit.slice(0, 8)}`,
    ),
  );
  for (const tool of pins.goTools) {
    stamped(path.join(out, `.${tool.name}`), keyOf(tool, 1), () =>
      goBuild(
        go,
        tool.name,
        target,
        path.join(out, tool.name, ...(tool.subdir ? [tool.subdir] : []), `${tool.name}${exe}`),
        tool.versionVariable ? `-X ${tool.versionVariable}=${tool.version}` : '',
      ),
    );
  }

  // ctags (Arduino's fork of Exuberant Ctags): arduino-cli runs it on .ino sketches.
  stamped(path.join(out, '.ctags'), keyOf(pins.ctags, 1), () => {
    const src = freshCopy(path.join(upstreamDir, 'ctags'), path.join(buildRoot, target, 'ctags'));
    const version = `-DPROGRAM_VERSION=\\"${pins.ctags.version}\\"`;
    if (target === 'windows') {
      sh(
        `make -f mk_mingw.mak CC=${MINGW}-gcc CFLAGS='-O2 -static ${version}' ctags.exe && ${MINGW}-strip ctags.exe`,
        src,
      );
    } else {
      // Cross builds can't run configure's regcomp test; regcomp works everywhere.
      sh(
        `autoheader && autoconf && regcomp_works=yes ./configure CFLAGS=-O2 && make -j${jobs()} CFLAGS='-O2 ${version}' ctags && strip ctags`,
        src,
      );
    }
    mkdirSync(path.join(out, 'ctags'), { recursive: true });
    cpSync(path.join(src, `ctags${exe}`), path.join(out, 'ctags', `ctags${exe}`));
  });

  // avrdude 8.0 with Arduino's version patch, serial programmers only.
  stamped(path.join(out, '.avrdude'), keyOf(pins.avrdude, pins.avrdudePacking, 2), () => {
    const src = freshCopy(
      path.join(upstreamDir, 'avrdude'),
      path.join(buildRoot, target, 'avrdude-src'),
    );
    for (const patch of pins.avrdudePacking.patches) {
      run('git', ['apply', path.join(upstreamDir, 'avrdude-packing', patch)], { cwd: src });
    }
    const cmakeBuild = path.join(buildRoot, target, 'avrdude-build');
    const prefix = path.join(out, 'avrdude');
    rmSync(cmakeBuild, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
    const args = [
      '-S',
      src,
      '-B',
      cmakeBuild,
      '-G',
      'Ninja',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      `-DEXTRA_VERSION=${pins.avrdude.extraVersion}`,
      '-DUSE_STATIC_LIBS=ON',
      // No Python bindings (they install into the system's Python).
      '-DCMAKE_DISABLE_FIND_PACKAGE_SWIG=ON',
      ...[
        'LIBELF',
        'LIBUSB',
        'LIBUSB_1_0',
        'HIDAPI',
        'LIBFTDI',
        'LIBFTDI1',
        'LIBREADLINE',
        'LIBSERIALPORT',
        'LINUXGPIO',
        'LINUXSPI',
      ].map((lib) => `-DHAVE_${lib}=NO`),
    ];
    if (target === 'windows') {
      const toolchain = path.join(buildRoot, 'windows', 'mingw.cmake');
      writeFileSync(
        toolchain,
        [
          'set(CMAKE_SYSTEM_NAME Windows)',
          'set(CMAKE_SYSTEM_PROCESSOR x86_64)',
          `set(CMAKE_C_COMPILER ${MINGW}-gcc)`,
          `set(CMAKE_CXX_COMPILER ${MINGW}-g++)`,
          `set(CMAKE_RC_COMPILER ${MINGW}-windres)`,
          `set(CMAKE_FIND_ROOT_PATH /usr/${MINGW})`,
          'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
          'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
          'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
          '',
        ].join('\n'),
      );
      args.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, '-DCMAKE_EXE_LINKER_FLAGS=-static');
    }
    run('cmake', args);
    run('cmake', ['--build', cmakeBuild]);
    run('cmake', ['--install', cmakeBuild, '--strip']);
  });
}

// --- the AVR compiler: binutils, GCC, avr-libc ---------------------------------------

function toolchainSources(work) {
  const t = pins.avrGcc.tarballs;
  const patches = path.join(upstreamDir, 'toolchain-avr');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  run('tar', ['-xjf', download(t.binutils), '-C', work]);
  for (const patch of pins.avrGcc.binutilsPatches) {
    run('patch', ['-p1', '-i', path.join(patches, patch)], { cwd: path.join(work, 'binutils') });
  }
  run('tar', ['-xJf', download(t.gcc), '-C', work]);
  const gcc = path.join(work, 'gcc');
  sh(`mv gcc-7.3.0 gcc`, work);
  run('patch', ['-s', '-p1', '-i', path.join(patches, pins.avrGcc.gccPatch)], { cwd: gcc });
  run('tar', ['-xjf', download(t.gmp), '-C', gcc]);
  run('tar', ['-xjf', download(t.mpfr), '-C', gcc]);
  run('tar', ['-xzf', download(t.mpc), '-C', gcc]);
  sh('mv gmp-* gmp && mv mpfr-* mpfr && mv mpc-* mpc', gcc);
}

// Old sources, modern compilers: C without -fno-common (GCC 10's default) and
// GCC 7's C++ in C++98 mode. Docs aren't built (no makeinfo needed).
const HOST_FLAGS = "CFLAGS='-w -O2 -g0 -fcommon' CXXFLAGS='-w -O2 -g0 -std=gnu++98'";

function buildToolchain(target) {
  const version = pins.avrGcc.version;
  const key = keyOf(pins.avrGcc, HOST_FLAGS, 3);
  const work = path.join(buildRoot, target, 'avr-gcc-work');
  const prefix = path.join(buildRoot, target, 'avr-gcc');
  const linuxPrefix = path.join(buildRoot, 'linux', 'avr-gcc');
  if (target === 'windows' && !existsSync(path.join(linuxPrefix, 'bin', 'avr-gcc'))) {
    // A Canadian cross: the Windows compiler's target libraries are built by (and
    // copied from) the Linux one.
    buildToolchain('linux');
  }
  stamped(path.join(prefix, '.triage-build'), key, () => {
    console.log(`Building avr-gcc ${version} for ${target} (about 20 minutes) …`);
    toolchainSources(work);
    rmSync(prefix, { recursive: true, force: true });
    const host = target === 'windows' ? `--host=${MINGW}` : '';
    const ldflags =
      target === 'windows'
        ? "LDFLAGS='-s -static -static-libgcc -static-libstdc++'"
        : "LDFLAGS='-s'";
    const path_ = `${path.join(linuxPrefix, 'bin')}:${process.env.PATH}`;
    const env = { PATH: path_ };
    const common = `--prefix=${prefix} --target=avr --disable-nls ${host}`;

    mkdirSync(path.join(work, 'b-binutils'), { recursive: true });
    sh(
      `${HOST_FLAGS} ${ldflags} ../binutils/configure ${common} --disable-doc --disable-werror --disable-gdb --disable-readline --disable-sim --disable-libdecnumber && ` +
        `make -j${jobs()} MAKEINFO=true configure-host && make -j${jobs()} MAKEINFO=true all && make MAKEINFO=true install`,
      path.join(work, 'b-binutils'),
      env,
    );

    mkdirSync(path.join(work, 'b-gcc'), { recursive: true });
    const gccConfig =
      `${HOST_FLAGS} ${ldflags} ../gcc/configure ${common} --enable-fixed-point --enable-languages=c,c++ ` +
      '--disable-libssp --disable-libada --disable-shared --with-avrlibc=yes --with-dwarf2 --disable-doc --without-isl';
    if (target === 'windows') {
      // The host programs and the LTO plugin; the target libraries come from Linux.
      sh(
        `${gccConfig} && make -j${jobs()} MAKEINFO=true all-gcc all-lto-plugin && make MAKEINFO=true install-gcc install-lto-plugin`,
        path.join(work, 'b-gcc'),
        env,
      );
      // libgcc, avr-libc and the linker scripts (not the Linux programs in avr/bin).
      const linuxBin = path.join(linuxPrefix, 'avr', 'bin');
      for (const part of [path.join('lib', 'gcc', 'avr'), 'avr']) {
        cpSync(path.join(linuxPrefix, part), path.join(prefix, part), {
          recursive: true,
          force: false,
          filter: (f) => f !== linuxBin && !f.startsWith(linuxBin + path.sep),
        });
      }
    } else {
      sh(
        `${gccConfig} && make -j${jobs()} MAKEINFO=true && make MAKEINFO=true install`,
        path.join(work, 'b-gcc'),
        env,
      );
      buildAvrLibc(work, prefix);
      // The target libraries without their debug info (217 → 124 MB; the code is the same).
      sh(
        `find lib/gcc avr/lib \\( -name '*.a' -o -name '*.o' \\) -print0 | xargs -0 -n 200 bin/avr-strip --strip-debug`,
        prefix,
      );
    }
    // Not needed to compile: documentation, GCC's plugin headers, GDB's libcc1.
    rmSync(path.join(prefix, 'share'), { recursive: true, force: true });
    rmSync(path.join(prefix, 'lib', 'gcc', 'avr', '7.3.0', 'plugin'), {
      recursive: true,
      force: true,
    });
    for (const name of readdirSync(path.join(prefix, 'lib'))) {
      if (name.startsWith('libcc1')) rmSync(path.join(prefix, 'lib', name), { force: true });
    }
    rmSync(work, { recursive: true, force: true });
  });
}

/** avr-libc 2.0.0 (Atmel's, with Arduino's patches and Atmel's device headers). */
function buildAvrLibc(work, prefix) {
  const t = pins.avrGcc.tarballs;
  run('tar', ['-xjf', download(t.avrLibc), '-C', work]);
  sh('mv libc/avr-libc avr-libc && rmdir libc', work);
  const src = path.join(work, 'avr-libc');
  for (const patch of pins.avrGcc.avrLibcPatches) {
    run('patch', ['-p1', '-i', path.join(upstreamDir, 'toolchain-avr', patch)], { cwd: src });
  }
  run('unzip', ['-q', '-o', download(t.avr8Headers), '-d', path.join(work, 'avr8-headers')]);
  sh(
    `for i in ../avr8-headers/avr/io[0-9a-zA-Z]*.h; do cp -f "$i" include/avr/; done && ./bootstrap`,
    src,
  );
  mkdirSync(path.join(work, 'b-avr-libc'), { recursive: true });
  sh(
    `CC=avr-gcc CXX=avr-g++ CFLAGS='-w -Os' ../avr-libc/configure --prefix=${prefix} --host=avr --enable-device-lib --libdir=${prefix}/lib --disable-doc && ` +
      `make -j${jobs()} && make install`,
    path.join(work, 'b-avr-libc'),
    { PATH: `${path.join(prefix, 'bin')}:${process.env.PATH}` },
  );
}

// --- stage ------------------------------------------------------------------------

function stage(target) {
  const out = stageDir(target);
  const tools = path.join(buildRoot, target, 'tools');
  const exe = exeOf(target);
  const packages = path.join(out, 'data', 'packages');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'bin'), { recursive: true });
  cpSync(
    path.join(tools, 'arduino-cli', `arduino-cli${exe}`),
    path.join(out, 'bin', `arduino-cli${exe}`),
  );

  // The platform, exactly where `arduino-cli core install arduino:avr@1.8.8` puts it.
  const p = pins.platform;
  const platformDir = path.join(packages, p.packager, 'hardware', p.architecture, p.version);
  const core = path.join(repoRoot, 'engines', 'arduino-avr', 'upstream');
  if (!existsSync(path.join(core, 'platform.txt'))) {
    throw new ForkError('the Arduino AVR core is missing: run the fetch step');
  }
  cpSync(core, platformDir, { recursive: true, filter: (f) => path.basename(f) !== '.git' });
  cpSync(path.join(dir, p.installedJson), path.join(platformDir, 'installed.json'));

  const toolDir = (packager, name, version) =>
    path.join(packages, packager, 'tools', name, version);
  cpSync(
    path.join(buildRoot, target, 'avr-gcc'),
    toolDir('arduino', 'avr-gcc', pins.avrGcc.version),
    { recursive: true, filter: (f) => path.basename(f) !== '.triage-build' },
  );
  cpSync(path.join(tools, 'avrdude'), toolDir('arduino', 'avrdude', pins.avrdude.version), {
    recursive: true,
  });
  for (const tool of pins.goTools) {
    cpSync(path.join(tools, tool.name), toolDir(tool.package, tool.name, tool.version), {
      recursive: true,
    });
  }
  cpSync(path.join(tools, 'ctags'), toolDir('builtin', 'ctags', pins.ctags.version), {
    recursive: true,
  });

  // The Arduino IDE's built-in examples (File → Examples).
  cpSync(path.join(upstreamDir, 'arduino-examples', 'examples'), path.join(out, 'examples'), {
    recursive: true,
  });

  // Empty indexes: arduino-cli then starts offline instead of downloading Arduino's
  // indexes at its first start; the Boards and Library Managers refresh them.
  writeFileSync(path.join(out, 'data', 'package_index.json'), '{"packages":[]}\n');
  writeFileSync(path.join(out, 'data', 'library_index.json'), '{"libraries":[]}\n');

  const manifest = {
    $comment: 'Triage Arduino engine (engines/arduino/build.mjs). Built from source.',
    os: target,
    arduinoCli: pins.arduinoCli.version,
    platform: `${p.packager}:${p.architecture}@${p.version}`,
    examples: pins.examples.tag,
    tools: {
      'avr-gcc': pins.avrGcc.version,
      avrdude: pins.avrdude.version,
      ctags: pins.ctags.version,
      ...Object.fromEntries(pins.goTools.map((t) => [t.name, t.version])),
    },
    sources: keyOf(pins),
  };
  writeFileSync(path.join(out, 'triage-arduino.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Staged the Arduino engine for ${target} in ${path.relative(process.cwd(), out)} (${sizeOf(out)} MB)`,
  );
}

function sizeOf(folder) {
  let bytes = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name);
      const s = statSync(f);
      if (s.isDirectory()) walk(f);
      else bytes += s.size;
    }
  };
  walk(folder);
  return Math.round(bytes / 1e6);
}

// --- verify -----------------------------------------------------------------------

/** Compiles Blink for the Uno, Nano and Mega with the staged engine, on its own. */
function verify() {
  const out = stageDir(hostOs);
  const cli = path.join(out, 'bin', `arduino-cli${exeOf(hostOs)}`);
  const work = path.join(buildRoot, hostOs, 'verify');
  rmSync(work, { recursive: true, force: true });
  cpSync(path.join(out, 'data'), path.join(work, 'data'), { recursive: true });
  const env = {
    ARDUINO_DIRECTORIES_DATA: path.join(work, 'data'),
    ARDUINO_DIRECTORIES_USER: path.join(work, 'user'),
    ARDUINO_DIRECTORIES_DOWNLOADS: path.join(work, 'downloads'),
    ARDUINO_BUILD_CACHE_PATH: path.join(work, 'cache'),
    ARDUINO_UPDATER_ENABLE_NOTIFICATION: 'false',
  };
  run(cli, ['version'], { env });
  run(cli, ['core', 'list'], { env });
  const sketch = path.join(work, 'Blink');
  mkdirSync(sketch, { recursive: true });
  writeFileSync(
    path.join(sketch, 'Blink.ino'),
    [
      'void setup() { pinMode(LED_BUILTIN, OUTPUT); Serial.begin(9600); }',
      'void loop() { digitalWrite(LED_BUILTIN, HIGH); delay(500); blinkOff(); }',
      '// ctags finds this prototype: it is defined after its first use.',
      'void blinkOff() { digitalWrite(LED_BUILTIN, LOW); Serial.println("off"); delay(500); }',
      '',
    ].join('\n'),
  );
  for (const fqbn of ['arduino:avr:uno', 'arduino:avr:nano', 'arduino:avr:mega']) {
    run(
      cli,
      ['compile', '--fqbn', fqbn, '--output-dir', path.join(work, fqbn.split(':')[2]), sketch],
      {
        env,
      },
    );
    const hex = path.join(work, fqbn.split(':')[2], 'Blink.ino.hex');
    if (!existsSync(hex)) throw new ForkError(`compiling Blink for ${fqbn} made no ${hex}`);
  }
  console.log('The staged Arduino engine compiles Blink for the Uno, Nano and Mega.');
}

// --- main -------------------------------------------------------------------------

main(() => {
  const args = process.argv.slice(2);
  const osAt = args.indexOf('--os');
  const targets = osAt >= 0 ? args[osAt + 1].split(',') : [hostOs];
  const steps = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--os');
  for (const step of steps) {
    if (!STEPS.includes(step)) throw new ForkError(`unknown step "${step}" (${STEPS.join(', ')})`);
  }
  for (const target of targets) {
    if (!['linux', 'windows'].includes(target)) throw new ForkError(`unknown --os ${target}`);
  }
  const wanted =
    steps.length > 0 ? steps : STEPS.filter((s) => s !== 'verify' || targets.includes(hostOs));
  const building = wanted.some((s) => ['go', 'tools', 'toolchain'].includes(s));
  if (building && hostOs !== 'linux') {
    throw new ForkError(
      "the Arduino engine builds on Linux (Windows is cross-built there); on Windows, take it from the Arduino workflow's artifact (engines/arduino/README.md)",
    );
  }
  if (wanted.includes('fetch')) fetchAll();
  if (wanted.includes('go')) ensureGo();
  for (const target of targets) {
    if (wanted.includes('tools')) buildTools(target);
    if (wanted.includes('toolchain')) buildToolchain(target);
    if (wanted.includes('stage')) stage(target);
  }
  if (wanted.includes('verify')) verify();
});
