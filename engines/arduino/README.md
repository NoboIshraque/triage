# engines/arduino: Triage's Arduino engine

Everything the Arduino IDE 2 uses to build and upload, built from source and shipped
inside Triage (ROADMAP PA-2, [ADR 0006](../../docs/adr/0006-arduino-built-in.md)), so
nobody needs to install the Arduino IDE:

| Part | Version | Source |
|---|---|---|
| arduino-cli | 1.6.0 (the Arduino IDE 2's own) | `arduino/arduino-cli` |
| serial-discovery, serial-monitor, mdns-discovery | 1.5.2, 0.15.0, 1.1.0 | `arduino/*` (Go) |
| arduinoOTA | 1.3.0 | `arduino/arduinoOTA` (Go) |
| ctags | 5.8-arduino12 | `arduino/ctags` (C) |
| avrdude | 8.0.0-arduino1 (8.0 with Arduino's version patch; serial programmers) | `avrdudes/avrdude`, `arduino/avrdude-packing` |
| avr-gcc | 7.3.0-atmel3.6.1-arduino7: GNU GCC 7.3.0 with Atmel's patches, Atmel's binutils 2.26 and avr-libc 2.0.0 with Arduino's patches | GNU, Atmel's 3.6.1 sources (Arduino's mirror), `arduino/toolchain-avr` |
| Arduino AVR Boards | 1.8.8 (Uno, Nano, Mega …) | `engines/arduino-avr` |

Every source is pinned in [`upstream.json`](upstream.json) by tag and commit or by
SHA-256; nothing prebuilt is downloaded. The versions are the ones Arduino's package
index lists for `arduino:avr` 1.8.8 and arduino-cli 1.6.0's builtin tools, so
arduino-cli finds each tool exactly where it would have installed its own, and the
Boards Manager shows Arduino AVR Boards 1.8.8 as installed.

## Build

On Linux (the Windows engine is cross-built there with mingw-w64, as Arduino builds
its own Windows compiler):

```sh
sudo apt-get install ninja-build flex bison autoconf automake unzip mingw-w64
node engines/arduino/build.mjs                    # this OS: fetch, go, tools, toolchain, stage, verify
node engines/arduino/build.mjs --os linux,windows # both engines (about 45 minutes the first time)
node engines/arduino/build.mjs verify             # compile Blink for the Uno, Nano and Mega
```

It needs Go 1.27.3 or later for arduino-cli; with an older Go (1.24.6 or later) on
PATH it builds the pinned Go from source first. `TRIAGE_ARDUINO_BUILD_DIR` moves the
build elsewhere.

On Windows, take the engine from CI: the newest green **Arduino** workflow run →
artifact **triage-arduino-windows** → unpack `triage-arduino-windows.tar.gz` into
`engines/arduino/build/windows/stage/` (`tar -xzf … -C …`).

## Layout

`build/<os>/stage/` is what the app ships in `resources/app/engines/arduino/`:

```
bin/arduino-cli(.exe)
data/packages/arduino/hardware/avr/1.8.8/       the core, with installed.json
data/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/
data/packages/arduino/tools/avrdude/8.0.0-arduino1/
data/packages/arduino/tools/arduinoOTA/1.3.0/
data/packages/builtin/tools/{ctags,serial-discovery,serial-monitor,mdns-discovery}/<version>/
data/package_index.json, data/library_index.json   empty: arduino-cli starts offline
triage-arduino.json                                 what was built
```

On first use, `sim/src/arduino.ts` copies `data/` into the user's own Arduino folder
(`%LOCALAPPDATA%\Triage\Arduino` on Windows, `~/.local/share/triage/arduino` on
Linux; `TRIAGE_ARDUINO_HOME` overrides it), where the Boards and Library Managers
install more. The indexes start empty, so arduino-cli never downloads Arduino's
indexes by itself; the Boards and Library Managers refresh them when opened.
