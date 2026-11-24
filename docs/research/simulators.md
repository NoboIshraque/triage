# Teardown: simulation engines

Targets are the engines Triad can embed or learn from, analyzed with REA in
**unbounded mode**, plus Wokwi, the leading MCU simulator for VS Code. Paid
simulator games (BeamNG.drive, Kerbal Space Program) could not be acquired in this
environment. Their lessons come from public docs ([market-and-standards.md](market-and-standards.md)).

Legend: **[O]** observed · **[S]** read in shipped, readable source · **[I]** inferred · **[D]** docs · **[?]** unknown.

---

## 1. ngspice: circuit simulation (SPICE)

**Target:** `libngspice.so.0.0.9` (Ubuntu 24.04 `libngspice0` 42). KiCad dlopens the
same library ([kicad.md](kicad.md)). It has 32 exports, 16 of them API [O]:

```
ngSpice_Init        ngSpice_Init_Sync   ngSpice_Init_Evt   ngCM_Input_Path
ngSpice_Circ        ngSpice_Command     ngSpice_running    ngSpice_SetBkpt
ngSpice_CurPlot     ngSpice_AllPlots    ngSpice_AllVecs    ngGet_Vec_Info
ngSpice_AllEvtNodes ngGet_Evt_NodeInfo  ngSpice_LockRealloc ngSpice_UnlockRealloc
```

| Hook | Use in Triad |
|---|---|
| `ngSpice_Init` (output, status, data, background-thread callbacks) | run transient sims on a background thread and stream vectors live |
| **`ngSpice_Init_Sync`** (`GetVSRCData`, `GetISRCData`, `GetSyncData`) | **external sources whose values Triad supplies per step**, so MCU pins drive the analog circuit |
| **`ngSpice_SetBkpt(t)`** | stop at time *t*, giving **lockstep** with MCU emulators |
| `ngSpice_Init_Evt`, `ngGet_Evt_NodeInfo`, `ngSpice_AllEvtNodes` | read XSPICE digital event nodes |
| `ngSpice_Circ(char**)` | load the netlist generated from the schematic |
| `ngCM_Input_Path` | locate XSPICE code models |

`eecircuit-engine` 1.9.0 (npm) ships ngspice compiled to **WebAssembly** in a 20 MB ES
module, which proves batch SPICE runs in a browser or worker [O + S].

## 2. simavr: AVR emulator (C)

`libsimavr.so.2` (Ubuntu 1.6): 206 exports, 100 `avr_*` [O]. The wiring model is an
**IRQ graph** (`avr_alloc_irq`, `avr_connect_irq`, `avr_irq_register_notify`,
`avr_raise_irq`/`_float`). Time is a **cycle-timer queue**
(`avr_cycle_timer_register`/`_usec`). There are peripheral inits (ADC, UART, SPI,
TWI, timers, EEPROM, watchdog, USB), a **GDB stub** (`avr_gdb_init`) and **VCD
waveforms** (`avr_vcd_*`).

## 3. avr8js and rp2040js: MCU emulators in JavaScript

npm `avr8js` 0.21.1 (72 JS files) and `rp2040js` 1.4.2 (208 JS files), every file
parsed by REA [O].

- **avr8js:** `cpu/cpu.js`, `instruction.js`, `interrupt.js`, plus one module per
  peripheral (gpio, timer, usart, spi, twi, adc, eeprom, clock, watchdog, usi).
  Timing uses a cycle counter plus an ordered clock-event list
  (`addClockEvent(cb, cycles)`) [S]. Pins: `AVRIOPort.addListener`, `pinState`, `setPin` [S].
- **rp2040js:** `cortex-m0-core`, `rp2040` SoC, `simulator`, `gpio-pin`, peripherals
  (adc, i2c, spi, **pio**, pwm, ssi, watchdog, usb CDC) and a **GDB TCP server** [O].
  `Simulator.execute()` runs cycle batches, advances a `SimulationClock` by
  `cycles × cycleNanos`, **skips to the next alarm while the core sleeps**, and
  yields with `setTimeout(0)` [S].

## 4. Renode: multi-architecture system emulator (.NET)

**Target:** Renode **1.16.1** (build 2026-06-23), 2,741 files, 482 managed assemblies [O].

**Complete inventory of `Infrastructure.dll`** (unbounded; refused by bounded REA at
its 64 MiB budget): **6,794 types, 45,476 methods, 64,866 fields, 205,442 call edges,
111,152 field accesses, 27,978 string literals**, coverage complete [O].

- **1,248 peripheral model types** [O]: Miscellaneous 206, CPU 159, Timers 102,
  UART 92, SPI 67, Bus 57, Sensors 47+9, I2C 45, GPIOPort 45, Storage 43, DMA 42,
  IRQControllers 40, USB 50, Wireless 34, Network 29, PCI 22, Analog 20, SD 19,
  Input 19, MTD 18, Video 12, CAN 11, Sound 10...
- **143 CPU types**: Cortex-M, ARMv7-A/R, ARMv8-A/R, RISC-V (RiscV32/64, VexRiscv,
  Ibex, PicoRV32, CV32E40P, Minerva...), PowerPC, SPARC, x86/KVM [O].
- **Peripheral contracts** [O]: `IPeripheral.Reset`; bus peripherals implement
  `ReadDoubleWord`/`WriteDoubleWord` (and byte/word variants); **`GPIO`** has
  `Set`, `Toggle`, `Connect`, `Disconnect`, `IsSet`, `AddStateChangedHook`; receivers
  implement **`IGPIOReceiver.OnGPIO`**. `LED` has `OnGPIO`, `State` and
  `StateChanged`; `Button` has `Press`, `Release`, `PressAndRelease`, `Toggle` and `Inverted`.
- **Time framework (20 types)** [O]: `MasterTimeSource` (`Run`, `RunFor`, `Start`,
  `Stop`), `SlaveTimeSource`, `TimeHandle`, `TimeInterval`, `TimeStamp`, `ClockEntry`,
  `ITimeDomain`, `ITimeSink`, `Sleeper`, `RealTimeClockMode`. `TimeSourceBase` (62
  methods) runs explicit **grant, sync, unblock and wait phases** and offers
  **`ExecuteInNearestSyncedState`** to inject outside events at sync points.
- **Co-simulation plugin** [O]: `ProtocolMessage {ActionId, Address, Data,
  PeripheralIndex}`. `ActionType`: TickClock, Step, Read/WriteToBus (8–64 bit),
  Push/Get, Interrupt, Register Get/Set, IsHalted, Handshake, Reset, Disconnect,
  OK/Error. Runs over an in-process `LibraryConnection` or a `SocketConnection`,
  with GPIO via `SendGPIO`/`RegisterOnGPIOReceive`.
- **`.repl` platform files are netlists** (118 CPU + 80 board files), for example
  `gpioPortA: 5 -> externalLed@0` [O].
- Docs: quantum-based virtual time, paced to real time by default [D].

**For Triad:** generate `.repl` from the schematic netlist. Inject circuit and
physics results with `ExecuteInNearestSyncedState`-style hooks at quantum
boundaries. Copy the small message vocabulary for Triad's own unit protocol.

## 5. MuJoCo: multibody physics

`libmujoco.so.4.0.1`: **822 exports** [O]: `mj_*` 237 (step, step1/step2, forward,
inverse, compile, recompile), **`mjs_*` 158 (programmatic model building)**, `mju_*`
217, `mjv_*`/`mjr_*`/`mjui_*` 77, `mjd_*` 26 (derivatives), **`mjb_*` 25 (batch
rollouts)**, `mjp_*` 19 (plugins/providers), **`mjcb_*` 8 (control, sensor,
act_dyn/gain/bias, passive, contactfilter, time)**, `mjc_*` 36 (collision incl. IPC
flex contacts). Plugins: actuator, sensor, SDF [O].

**For Triad:** build models from the CAD assembly with `mjs_*` (no XML). Inject
motor torque through `mjcb_control`/`mjcb_act_*`. Read IMU, rangefinder and
contact sensors. Reduced coordinates keep jointed mechanisms stable.

## 6. Wokwi for VS Code 4.1.0 (leading MCU simulator)

**Target:** `Wokwi.wokwi-vscode-4.1.0.vsix` from Open VSX (17 MB unpacked, 47 files) [O].

| Fact | Basis |
|---|---|
| Extension host code: `dist/extension.js`. Contributes a custom editor, a view container, JSON schemas for `diagram.json` and custom chips, and commands start, pause, resume, restart, stop and license | [O] package.json, REA graph (3 JS files parsed) |
| **`dist/engine.wasm` (11.6 MB) is not the MCU simulator.** It is **`wokwigw`, the Wokwi IoT Gateway**, a Go 1.20.14 program (GOOS=js GOARCH=wasm). It includes a gVisor netstack, gvisor-tap-vsock, a DHCP server, miekg/dns, gopacket, tcpproxy and `wokwigw/pkg/vnet/forwarder`, which give simulated boards **Wi-Fi/Internet through a virtual network** | [O] WASM import/export tables (Go `syscall/js` ABI; exports `run`, `resume`, `getsp`, `mem`) + embedded Go build info |
| The **simulator UI and engine load in a webview from `https://vscode.preview.wokwi.com`**, with license endpoints on `wokwi.com` | [O] strings in extension.js / [I] |
| Local services the extension provides: firmware loading (`.bin`, `.elf`), `wokwi.toml`/`diagram.json` config, a **GDB server bridge** (`gdbServerPort`), an **RFC2217 serial-over-TCP bridge**, and **ESP32-family ROM images** (ESP32, S2, S3, C2, C3, C5, C6, C61, H2, P4, S31) with symbols | [O] files + strings |
| `diagram.json`: `parts[] {id, type, left, top, rotate, attrs, hide}`, `connections[]`, `serialMonitor`. Custom chip JSON: `pins`, **`controls`** (UI sliders: id, label, type, min, max, step), **`display`** (framebuffer) | [O] schemas |

**Lessons for Triad:**
1. Run emulation **client-side** for zero-latency interaction (Wokwi's runs in
   the webview).
2. IoT boards need a **virtual network gateway**: a user-space TCP/IP stack with
   DHCP and DNS forwarding to the host.
3. **Bridges matter:** a GDB server (debuggers) and RFC2217 serial (external
   terminals and tools) make the simulator part of the normal toolchain.
4. Part models declare **pins + UI controls + display** in one small manifest.
   Triad's smart parts follow that shape (PLAN §4.6).

## 7. Others (from docs)

| Engine | Role for Triad |
|---|---|
| QEMU (Espressif fork) | ESP32 targets as a separate process with gdbstub, plus a virtual network gateway for Wi-Fi |
| SimulIDE | real-time MCU and circuit sim built on simavr and gpsim; its "not very accurate" models are the reason for fidelity tiers |
| Falstad CircuitJS | best-known real-time MNA visual simulator; inspiration for the fast tier |
| Xyce, Qucs-S | alternative SPICE back ends |
| Project Chrono, Jolt, PhysX 5, Bullet, Rapier | physics alternatives (Jolt or Rapier for a light web tier) |
| CalculiX, Elmer, OpenFOAM (via FreeCAD FEM) | stress, thermal and CFD in later phases |
| FMI 3.0 / SSP | third-party model plug-ins |

## 8. Unknowns and limits

- [?] Wokwi's MCU emulator internals: they are delivered from its web service at
  runtime and are not in the package.
- [?] ngspice WASM co-sim hooks and MuJoCo WASM status.
- Hook semantics for ngspice and MuJoCo come from docs. REA observed names, not behavior.
