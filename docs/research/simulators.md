# Teardown: simulation engines

Targets are the engines Triage can embed or learn from, analyzed with REA in
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

| Hook | Use in Triage |
|---|---|
| `ngSpice_Init` (output, status, data, background-thread callbacks) | run transient sims on a background thread and stream vectors live |
| **`ngSpice_Init_Sync`** (`GetVSRCData`, `GetISRCData`, `GetSyncData`) | **external sources whose values Triage supplies per step**, so MCU pins drive the analog circuit |
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

**For Triage:** generate `.repl` from the schematic netlist. Inject circuit and
physics results with `ExecuteInNearestSyncedState`-style hooks at quantum
boundaries. Copy the small message vocabulary for Triage's own unit protocol.

## 5. MuJoCo: multibody physics

`libmujoco.so.4.0.1`: **822 exports** [O]: `mj_*` 237 (step, step1/step2, forward,
inverse, compile, recompile), **`mjs_*` 158 (programmatic model building)**, `mju_*`
217, `mjv_*`/`mjr_*`/`mjui_*` 77, `mjd_*` 26 (derivatives), **`mjb_*` 25 (batch
rollouts)**, `mjp_*` 19 (plugins/providers), **`mjcb_*` 8 (control, sensor,
act_dyn/gain/bias, passive, contactfilter, time)**, `mjc_*` 36 (collision incl. IPC
flex contacts). Plugins: actuator, sensor, SDF [O].

**For Triage:** build models from the CAD assembly with `mjs_*` (no XML). Inject
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

**Lessons for Triage:**
1. Run emulation **client-side** for zero-latency interaction (Wokwi's runs in
   the webview).
2. IoT boards need a **virtual network gateway**: a user-space TCP/IP stack with
   DHCP and DNS forwarding to the host.
3. **Bridges matter:** a GDB server (debuggers) and RFC2217 serial (external
   terminals and tools) make the simulator part of the normal toolchain.
4. Part models declare **pins + UI controls + display** in one small manifest.
   Triage's smart parts follow that shape (PLAN §4.6).

## 7. Board emulation for the owner's boards (ESP32, Arduino, Raspberry Pi)

Added 2026-11-24 after the owner named the boards ([ADR 0003](../adr/0003-boards-and-windows.md)).
Package facts come from the packages analyzed above; the rest is vendor documentation.

| Board family | Emulator | What it covers | What Triage adds | Basis |
|---|---|---|---|---|
| Arduino Uno, Nano (ATmega328P), Mega 2560 | avr8js 0.21.1 | AVR core with 22-bit program counter support (`pc22Bits`, `eind` in `cpu/cpu.js`, needed for the Mega's flash); peripherals as in §3 | parts, circuit coupling | [O] package |
| Raspberry Pi Pico (RP2040), Nano RP2040 Connect | rp2040js 1.4.2 | `dist/esm/peripherals/`: adc, busctrl, clocks, dma, i2c, io, pads, pio, pll, ppb, psm, pwm, reset, rtc, spi, ssi, syscfg, sysinfo, tbman, timer, uart, usb, watchdog, xosc. The README shows MicroPython running (a CI workflow and a REPL demo) | no RP2350 (Pico 2): no matches in the package; no Pico W radio model | [O] package |
| ESP32, ESP32-S3, ESP32-C3 | Espressif's QEMU fork (`esp-develop` branch) | CPU (dual-core on ESP32/S3), UART, interrupt matrix, GPIO strapping, NOR flash (SPI, MMU, encryption), PSRAM, eFuse, RNG, AES/SHA/RSA, HMAC and digital signature (S3/C3), GDMA (S3/C3), SysTimer (S3/C3), timer groups, TWAI/CAN, SD/MMC (ESP32), LEDC (ESP32 only), virtual OpenCores Ethernet, virtual RGB framebuffer | **not emulated:** Wi-Fi, Bluetooth, USB, RMT, general-purpose SPI, I²C, I²S, ULP, GPIO matrix/IOMUX, LEDC on S3/C3; ADC isn't listed | [D] [feature table](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md) |
| Arduino Uno R4 Minima (RA4M1), Nano 33 BLE (nRF52840) | Renode 1.16.1 | `platforms/boards/arduino_uno_r4_minima.repl` and `arduino_nano_33_ble.repl`; CPUs `renesas-r7fa4m1a.repl` and `nrf52840.repl`; scripts `single-node/arduino_uno_r4_minima.resc` and `complex/arduino_nano/nrf52840_arduinoIDE_integration.resc` | check peripheral coverage per sketch | [O] package listing |
| Raspberry Pi 4/5, Python projects | none (the script runs natively) | gpiozero pin factories: the `GPIOZERO_PIN_FACTORY` variable selects one; the built-in `MockFactory` makes fake pins (PWM through `MockPWMPin`); custom factories subclass `Factory` | a Triage pin factory, plus `RPi.GPIO`, `smbus2`, `spidev`, `pyserial` shims | [D] [gpiozero: API - Pins](https://gpiozero.readthedocs.io/en/stable/api_pins.html) |
| Raspberry Pi full system | QEMU `raspi3b`, `raspi4b` | `raspi4b`: BCM2838 SoC with a GPIO controller (58 lines, based on the BCM2835 model), Genet Ethernet, PCIe, RNG200, thermal sensor. Merged in the target-arm queue in February 2024; present in v9.1 and later | GPIO bridge to the kernel; Raspberry Pi OS boot flow | [D] [`hw/arm/raspi4b.c`](https://qemu.googlesource.com/qemu/+/refs/heads/master/hw/arm/raspi4b.c), [patch series](https://patchew.org/QEMU/20240219011739.2316619-1-sergey.kambalin@auriga.com) |

Renode 1.16.1 ships no RP2040, ESP32 or BCM283x platform files [O].

**ESP32 networking in Espressif's QEMU** [D]: an ESP-IDF app enables
`CONFIG_ETH_USE_OPENETH` and creates the MAC with `esp_eth_mac_new_openeth`, and
QEMU runs with `-nic user,model=open_eth` (NAT, TCP/UDP only), plus `hostfwd=` for
servers. Wi-Fi APIs don't work: "The Ethernet controller can be used for networking
instead". So an unchanged Arduino sketch calling `WiFi.begin()` needs Triage's
Wi-Fi shim ([ESP32 QEMU guide](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32/README.md)).

**Maintenance** [D]: Espressif says `esp-develop` "will often be rebased on top of
the upstream master branch and force-pushed", and that it does not provide support
for QEMU. Triage pins a commit.

## 8. Others (from docs)

| Engine | Role for Triage |
|---|---|
| QEMU (Espressif fork) | ESP32 family as a separate process with a gdbstub (§7), plus the virtual network gateway |
| SimulIDE | real-time MCU and circuit sim built on simavr and gpsim; its "not very accurate" models are the reason for fidelity tiers |
| Falstad CircuitJS | best-known real-time MNA visual simulator; inspiration for the fast tier |
| Xyce, Qucs-S | alternative SPICE back ends |
| Project Chrono, Jolt, PhysX 5, Bullet, Rapier | physics alternatives (Jolt or Rapier for a light web tier) |
| CalculiX, Elmer, OpenFOAM (via FreeCAD FEM) | stress, thermal and CFD in later phases |
| FMI 3.0 / SSP | third-party model plug-ins |

## 9. Unknowns and limits

- [?] Wokwi's MCU emulator internals: they are delivered from its web service at
  runtime and are not in the package.
- [?] ngspice WASM co-sim hooks and MuJoCo WASM status.
- [?] How Wokwi emulates ESP32 Wi-Fi, and whether its RP2350 emulator is open.
- [?] Espressif QEMU speed on Windows with virtual-time sync. Measure early in P4.
- Hook semantics for ngspice and MuJoCo come from docs. REA observed names, not behavior.
