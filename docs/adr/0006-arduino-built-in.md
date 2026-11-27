# ADR 0006: Arduino built in: compile, upload, libraries, boards and examples inside Triage, with buttons

- **Status:** **Accepted**, 2026-11-27. The owner decided **what** (the end of this
  ADR: the scope, the order and how other boards' compilers arrive) when PA was
  planned, and **accepted the backend** (arduino-cli 1.6.0 built from source, as
  the Arduino IDE 2 uses it) at the start of phase PA, the same day.
- **Related:** [ADR 0001](0001-standalone-app-on-vscode-codebase.md) (VS Code
  fork), [ADR 0003](0003-boards-and-windows.md) (boards, Windows first), PLAN §1
  (principles), §4.11, §4.13, §4.15, ROADMAP phase **PA**, DEVIATIONS DV-29, DV-33,
  DV-34

## In plain words

**Everything the Arduino IDE does, Triage does in its own window, with buttons.**
You don't install the Arduino IDE. Triage comes with the compiler for the Uno,
Nano and Mega already inside.

- **Build and Upload buttons** above the code, like the Arduino IDE's ✓ and →. Plug
  an Arduino in over USB, pick it in the **board and port picker** in the status
  bar (Triage recognises a plugged-in Uno by itself), press **Upload**. Progress and
  errors show in plain words.
- A **Serial Monitor** for the real board, beside the simulator's.
- A **Library Manager**: search ("SSD1306", "DHT"), click **Install**, and the
  library is available to the code and to the simulation. The project remembers
  which libraries (and versions) it uses, so a copy on another laptop builds the
  same.
- A **Boards Manager**: the Uno, Nano and Mega are built in. Other boards (ESP32,
  Raspberry Pi Pico, …) install with a click: Triage downloads Arduino's own
  ready-made compiler for them, exactly as the Arduino IDE does, and checks it
  against Arduino's published checksums.
- **Examples:** File → Examples → Blink, Button, Fade, AnalogReadSerial, and each
  installed library's examples. An example opens as a new project you can run in
  the simulator or upload.

The simulator keeps running only the boards it can simulate (Uno and Nano now;
ESP32 and Pico come in P4). For the others, Triage compiles and uploads, and says
plainly that simulating that board comes later.

**Buttons first, everywhere.** The owner's rule (2026-11-27): everything a user
does in Triage has a button, a menu or a mouse gesture. The command palette, the
keyboard and the `triage` command line are extras. The command line exists so CI
can run the scenario tests without a window, and a user never needs it.

## Context

- Since P3, Triage builds firmware with its own avr-gcc driver
  (`sim/src/firmware.ts`) and ships Arduino's AVR core, but **borrows the
  compiler** from an installed Arduino IDE 2 or arduino-cli (DV-29). C6 tells the
  owner to install the Arduino IDE first.
- PLAN §4.15 said "Firmware runs only inside emulators": Triage had no way to put
  firmware on a real board. PLAN §4.11 lists arduino-cli and PlatformIO Core as
  toolchains but not how they reach the user.
- The owner (2026-11-27): the Arduino IDE should be built in, including upload,
  the Library Manager, the Boards Manager and examples, **now, before the phone
  companion (PC) and P4**; Triage must be usable with buttons and the mouse.

## Decision

1. **arduino-cli, built from source, is Triage's Arduino engine.** It is the
   engine inside the Arduino IDE 2 itself: the IDE is an Electron app that talks to
   `arduino-cli daemon` over gRPC for compiling, uploading, the board list, the
   Library and Boards Managers and the serial monitor [observed 2026-11-27 in the
   IDE 2's source, `arduino/arduino-ide` at `f467a6a`: `arduino-ide-extension/package.json`
   pins arduino-cli **1.6.0**; `src/node/arduino-daemon-impl.ts` starts it with
   `daemon`; the board, core, library, sketch and monitor services
   (`boards-service-impl.ts`, `core-service-impl.ts`, `library-service-impl.ts`,
   `sketches-service-impl.ts`, `monitor-service.ts`) are gRPC clients of it]. Triage does the same from a utility process, the way
   its other engines run (ADR 0002). It is Go, GPL-3.0; CI builds it from a pinned
   tag on Windows and Linux (`engines/arduino/`).
2. **The AVR tools are built from source and shipped:** GCC for AVR, binutils,
   avr-libc and avrdude, at versions matching what Arduino's AVR core expects,
   built in CI for Windows (x64) and Linux and installed where arduino-cli looks
   for the `arduino:avr` platform's tools. The pinned ArduinoCore-avr ships beside
   them (it already does). So Uno, Nano and Mega work offline from the first start.
3. **Other boards' compilers download on demand** from Arduino's package index,
   the same files the Arduino IDE installs, verified against the index's
   checksums (the owner's choice, 2026-11-27). Triage pins the index URL; adding
   third-party board URLs (ESP32's, Pico's) is a setting with a button, as in the
   IDE.
4. **Projects keep Triage's layout.** `firmware/src/main.cpp` and
   `firmware/generated/` stay (PlatformIO-style, P1-5). PA-2 decides between
   compiling through arduino-cli with a generated sketch wrapper, or keeping
   `sim/src/firmware.ts` for compiling and using arduino-cli for libraries,
   boards and upload; either way Blink, the Smart Fan and the examples compile the
   same in the simulator and for upload.
5. **Libraries are per project:** `triage.toml` lists them with versions;
   arduino-cli installs them into a Triage library folder; the firmware build, the
   simulation and C++ IntelliSense see the same set.
6. **Upload is tested without hardware in CI** (an emulated Uno bootloader behind
   a virtual serial port on Linux) and on real hardware by the owner (an owner
   check on Windows).

## Consequences

- Triage's installer grows by the AVR tools and arduino-cli (tens of MB).
- PLAN §4.15 changes: firmware runs inside emulators, or on the user's own board
  after they press Upload; it never runs on the laptop itself.
- The phone companion (PC) and everything after move by the length of PA (about
  5 weeks).
- The `triage` CLI stays, for CI and scripted grading (PLAN §1 job 4), never as
  the only way to do something.

## The owner's decisions (2026-11-27)

- **Scope:** upload to a real board (with its serial monitor), Library Manager,
  Boards Manager, examples; the compiler built in so no Arduino install is needed.
- **When:** now, as phase **PA**, after P3 and before PC (phone) and P4.
- **Other boards' compilers:** downloaded from Arduino's servers like the IDE,
  checksums checked. The Uno/Nano/Mega compiler is built from source and shipped.
- **Buttons and mouse first** for every action in Triage; the CLI is an extra.
- arduino-cli may run in CI's Windows jobs (it does since P3; DV-29).
- **Backend accepted** at PA's start (2026-11-27): arduino-cli built from source
  as the engine, with the AVR compiler, avrdude and arduino-cli's helper tools
  built from source and shipped.
- **Board for the upload check:** the owner has an Arduino **Nano or Mega**
  (2026-11-27), so the PA-3 owner check uses that board.
