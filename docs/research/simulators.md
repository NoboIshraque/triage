# Teardown: simulation engines

We analyzed the engines we could legally take apart and might actually embed:
open-source or permissively distributed builds. We did **not** reverse engineer
proprietary simulators (LTspice, Proteus VSM, Wokwi's cloud, BeamNG, Kerbal
Space Program), because their licenses generally forbid it and we don't need
their code. For those we studied public docs and observable behavior, summarized in
[market-and-standards.md](market-and-standards.md).

Legend: **[O]** observed by REA · **[S]** read in shipped, readable source · **[I]** inferred · **[D]** docs · **[?]** unknown.

---

## 1. ngspice: circuit simulation (SPICE)

**Target:** `libngspice.so.0.0.9` (Ubuntu 24.04 `libngspice0` 42). KiCad uses the
same library (see [kicad.md](kicad.md)).

**Exports:** 32 symbols in total, 16 of them API [O]:

```
ngSpice_Init        ngSpice_Init_Sync   ngSpice_Init_Evt   ngCM_Input_Path
ngSpice_Circ        ngSpice_Command     ngSpice_running    ngSpice_SetBkpt
ngSpice_CurPlot     ngSpice_AllPlots    ngSpice_AllVecs    ngGet_Vec_Info
ngSpice_AllEvtNodes ngGet_Evt_NodeInfo  ngSpice_LockRealloc ngSpice_UnlockRealloc
```

What these give a co-simulator [O names + D semantics]:

| Hook | Use in our system |
|---|---|
| `ngSpice_Init` (callbacks for output, status, data and background-thread state) | run sims on a background thread and stream vectors live |
| **`ngSpice_Init_Sync`** (`GetVSRCData`, `GetISRCData`, `GetSyncData`) | **external voltage and current sources whose values we supply per time step.** This is how an MCU pin drives the analog circuit |
| **`ngSpice_SetBkpt(t)`** | stop the transient at time *t*. This gives **lockstep sync** with the MCU emulator |
| `ngSpice_Init_Evt`, `ngGet_Evt_NodeInfo`, `ngSpice_AllEvtNodes` | read XSPICE **digital event nodes** for mixed-signal parts |
| `ngSpice_Circ(char**)` | load a netlist from memory (generated from the schematic) |
| `ngCM_Input_Path` | locate code-model libraries (`*.cm`) |

**License (Debian copyright):** mostly BSD-3-Clause (168 entries). But
`frontend/numparam` is **LGPL-2**, and `xspice/xspice.c`, the XSPICE table code
models and the ADMS device models are **GPL-2+** [O]. So a stock libngspice is
not purely permissive. This affects which process may load it (PLAN §4.12).

**Browser path:** `eecircuit-engine` 1.9.0 (MIT wrapper, npm) ships ngspice
compiled to **WebAssembly inside a 20 MB ES module**, with model files and a
`Simulation` class (`start`, `setNetList`, `runSim`) [O files + S README]. This
proves batch SPICE runs in a browser or worker. The co-sim hooks are not exposed
there [?].

---

## 2. simavr: AVR emulator (C)

**Target:** `libsimavr.so.2` (Ubuntu `libsimavr2` 1.6, **GPL-3+**). 206 exports,
100 of them `avr_*` [O]. Its architecture is visible from the API:

- Core: `avr_make_mcu_by_name`, `avr_init`, `avr_load_firmware`, `avr_run`,
  `avr_run_one`, `avr_reset`, `avr_terminate`.
- **The IRQ graph is the wiring model:** `avr_alloc_irq`, `avr_connect_irq`,
  **`avr_irq_register_notify`** (pin-change callbacks), **`avr_raise_irq`** /
  `avr_raise_irq_float` (drive inputs, including analog values), `avr_io_getirq`.
- **Time:** `avr_cycle_timer_register` / `_usec`, a cycle-ordered event queue.
- Peripherals: `avr_adc_init`, `avr_uart_init`, `avr_spi_init`, `avr_twi_init`,
  `avr_timer_init`, `avr_eeprom_init`, `avr_watchdog_init`, `avr_usb_init`, ...
- Debug and observability: **`avr_gdb_init`** (GDB remote stub) and
  **`avr_vcd_*`** (value-change-dump waveforms).

Lesson: peripherals and external parts meet through **typed signal endpoints
plus a cycle-timer queue**. We use the same shape for our signal bus.

---

## 3. avr8js and rp2040js: MCU emulators in JavaScript (MIT, by Wokwi's author)

**Targets:** npm `avr8js` 0.21.1 (72 JS files) and `rp2040js` 1.4.2 (208 JS
files). REA parsed every JS file in both packages, with 0 parse failures [O].

**avr8js** module inventory [O]: `cpu/cpu.js`, `cpu/instruction.js`,
`cpu/interrupt.js`; one module per peripheral: `gpio`, `timer` (+`timer-attiny`),
`usart`, `spi`, `twi`, `adc`, `eeprom`, `clock`, `watchdog`, `usi`; plus
`utils/assembler`. `gpio.js` exports `AVRIOPort`, `PinState`,
`PinOverrideMode`, the `portB…L` configs and `INT0/1`, `PCINT0–2` [O].

- **Timing model:** `cpu.cycles` counter plus an ordered **clock-event list**,
  `addClockEvent(callback, cycles)` and `updateClockEvent` [S].
- **Pin I/O:** `AVRIOPort.addListener(fn)`, `pinState(i)`, `setPin(i, value)` [S].

**rp2040js** module inventory [O]: `cortex-m0-core.js`, `rp2040.js` (SoC),
`simulator.js`, `gpio-pin.js`, `irq.js`, `interpolator.js`; peripherals
`adc`, `i2c`, `spi`, **`pio`**, `pwm`, `ssi`, `watchdog`, `xosc`, `busctrl`,
`psm`, `tbman`, `usb/usb-device` (CDC serial); and a **GDB server**
(`gdb/gdb-server.js`, `gdb-tcp-server.js`). Exports include `Simulator`,
`GPIOPin` and `RP2040` [O].

- **Run loop** (`Simulator.execute`) [S]: execute a batch of CPU cycles, advance
  a `SimulationClock` by `cycles × cycleNanos`, **jump directly to the next alarm
  when the core sleeps** (`clock.tick(nanosToNextAlarm)`), then yield with
  `setTimeout(…, 0)` so the UI stays responsive.
- **Pins:** `GPIOPin.addListener`, `setInputValue`, `outputEnable`, `value` [S].

Lesson: both are small, readable, embeddable in our Node or worker processes,
and already proven in a real product. They are **our first two MCU targets**
(Arduino Uno-class AVR and Raspberry Pi Pico).

---

## 4. Renode: multi-architecture system emulator (.NET, MIT)

**Target:** `renode-latest.linux-portable-dotnet.tar.gz` = **Renode 1.16.1
(build 2026-06-23)**. It has 2,741 files, 482 managed .NET assemblies and 346
bundled license files [O].

- `Infrastructure.dll` (9.3 MB, .NET 8) holds **6,794 types, 45,476 methods
  and 64,866 fields** [O metadata row counts]. REA refused its full member
  inventory because it exceeds REA's fixed **64 MiB metadata representation
  budget**, even with type selection [O limitation]. Those internals stay
  unknown to REA; use Renode's MIT source and docs instead.
- **CoSimulationPlugin.dll (fully inventoried, 29 types)** [O]:
  - `ICoSimulationConnectible`, `CoSimulatedPeripheral`, `CoSimulatedCPU`,
    `CoSimulatedRiscV32`, `CoSimulatedUART`, `CoSimulatedCFU`.
  - Transport: `CoSimulationConnection` over either **`LibraryConnection`**
    (an in-process shared library such as a Verilated model) or
    **`SocketConnection`**.
  - **Wire protocol: `ProtocolMessage { ActionId, Address, Data, PeripheralIndex }`**.
  - **`ActionType` vocabulary:** `TickClock`, `Step`, `SingleStepMode`,
    `ReadFromBus`/`WriteToBus` (Byte, Word, DoubleWord, QuadWord),
    `Push*`/`Get*` (Byte to QuadWord), `PushConfirmation`, `Interrupt`,
    `ResetPeripheral`, `RegisterGet`/`RegisterSet`, `IsHalted`, `Handshake`,
    `Disconnect`, `LogMessage`, `OK`, `Error`.
  - GPIO crosses the boundary through `SendGPIO`, `HandleGPIO` and
    `RegisterOnGPIOReceive`.
- **Platform files (`.repl`) are a netlist** [O]: 118 CPU and 80 board
  platform files. For example `stm32f4_discovery-additional_gpios.repl`:
  ```
  externalButton: Miscellaneous.Button @ gpioPortA
      -> gpioPortA@3
  externalLed: Miscellaneous.LED @ gpioPortA
  gpioPortA:
      5 -> externalLed@0
  ```
  The most-used peripheral kinds in the shipped boards include `Miscellaneous.LED`
  (89) and `Button` (54), `Python.PythonPeripheral` (117, scriptable models),
  STM32 timers and GPIO, NVIC and various UARTs.
- Boards include `arduino_uno_r4_minima`, `arduino_nano_33_ble`,
  `nrf52840dk_nrf52840`, several STM32 Nucleo and Discovery boards, and RISC-V and
  Renesas parts [O].
- **Time model** [D]: one virtual-time domain advances in **quanta**. Members
  never drift more than one quantum apart. A paused member blocks the domain, a
  halted CPU does not. By default it is paced to real time unless
  `AdvanceImmediately` is set.

Lesson: **generate `.repl` wiring from our schematic netlist.** For example,
MCU pin PA5 on net `LED_STATUS` connected to an LED becomes
`gpioPortA: 5 -> led_status@0`. Copy the **quantum time model** and the
**small message vocabulary** for our own kernel.

---

## 5. MuJoCo: multibody physics (Apache-2.0)

**Target:** `mujoco-core` 4.0.1 wheel, `libmujoco.so.4.0.1`, **822 exports** [O]:

| Family | Count | What it is |
|---|---|---|
| `mj_*` | 237 | simulation: `mj_step`, **`mj_step1`/`mj_step2`** (split step to inject controls), `mj_forward`, `mj_inverse`, `mj_loadXML`, `mj_compile`, `mj_recompile`, contact/Jacobian queries, VFS |
| **`mjs_*`** | 158 | **mjSpec, programmatic model building**: `mjs_addBody`, `addJoint`, `addGeom`, `addMesh`, `addActuator`, `addSensor`, `addEquality`, `addTendon`, `addFlex`, `attach`... |
| `mju_*` | 217 | math (sparse Cholesky, QP, quaternions) |
| `mjv_*` / `mjr_*` / `mjui_*` | 41 / 28 / 8 | visualization abstraction, OpenGL renderer, UI |
| `mjd_*` | 26 | derivatives (finite-difference transition matrices) for control and optimization |
| **`mjb_*`** | 25 | batch rollouts (parallel simulation) |
| `mjp_*` | 19 | plugins, resource providers, decoders/encoders |
| **`mjcb_*`** | 8 | callbacks: **`control`**, **`sensor`**, `act_dyn`, `act_gain`, `act_bias`, `passive`, `contactfilter`, `time` |
| `mjc_*` | 36 | collision (GJK/CCD, SDF, "ipc" flex contacts) |

Plugins ship as `plugin/libactuator.so`, `libsensor.so` and `libsdf_plugin.so` [O].

How it fits our system [I + D]:
- **Build the physics model straight from the CAD assembly with `mjs_*`**, with
  no hand-written XML. Rigidly attached parts become one body, mates and motors
  become joints and actuators, and masses and inertias come from OCCT mass
  properties.
- **Electro-mechanical coupling through `mjcb_control` and `mjcb_act_*`**: our
  motor model (V, R, L, Kt, Ke, gearing) computes torque from the
  circuit/PWM state each step, while the sensor callbacks feed IMU, encoder and
  rangefinder part models.
- **Reduced (generalized) coordinates** keep long chains stable. That is the
  cure for the "wobbly rocket" problem seen in games built on maximal-coordinate
  joints (see market doc).

---

## 6. Others (docs only, not reverse engineered)

| Engine | License | Role for us |
|---|---|---|
| QEMU (Espressif fork for ESP32) | GPL-2.0 | ESP32 targets, as a separate process with gdbstub |
| Wokwi | proprietary SaaS (cores avr8js/rp2040js are MIT) | Reference UX: `diagram.json`, `wokwi.toml`, **Custom Chips API** (C or Rust compiled to WASM: `pin_init`, `pin_watch`, `timer_init`...), GDB server, `wokwi-cli` for CI with `--expect-text`. We design **our own** part-model SDK in the same spirit |
| SimulIDE | AGPL-3.0 | Real-time MCU plus circuit sim built on simavr and gpsim. Its own docs say models are "not very accurate", which shows why we need two fidelity tiers |
| Falstad CircuitJS | GPL-2.0 | The best-known real-time MNA visual simulator. Inspiration for our fast tier (clean-room) |
| Xyce, Qucs-S | GPL-3 | Alternative SPICE back ends (parallel and large circuits) |
| Project Chrono, Jolt, PhysX 5, Bullet, Rapier | BSD/MIT/zlib/Apache | Alternatives. Jolt or Rapier for a light web tier; Chrono for vehicles and granular sims |
| CalculiX, Elmer, OpenFOAM | GPL | Later: stress, thermal and CFD as separate processes |
| FMI 3.0 / SSP | open standards | Plug-in model format and system description for third-party models |

## 7. Unknowns and limits

- [?] Renode `Infrastructure.dll` internals (REA representation budget).
- [?] ngspice WASM co-sim hooks, and MuJoCo official WASM status. Verify before committing to a web tier.
- Semantics of the ngspice and MuJoCo hooks come from docs. REA observed names, not behavior.
