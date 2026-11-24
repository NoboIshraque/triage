# ADR 0003: First targets: ESP32, Arduino and Raspberry Pi boards, on Windows laptops

- **Status:** Accepted, 2026-11-24 (owner: boards "Esp32, Arduino, raspberry pi";
  laptop OS "Windows")
- **Related:** PLAN §4.7 (simulation units), ROADMAP P0, P3, P4, P7

## Context

Simulating a board needs an emulator for its chip, and each board family is a
different engineering job. Students run Triage on their own laptops, and the
owner's is Windows. Claude's development sessions run on Linux, so Windows is
checked through CI and by the owner trying nightly builds.

What exists today, per board family:

| Board family | Emulator | What it already covers | What Triage must add | Basis |
|---|---|---|---|---|
| **Arduino** Uno, Nano (ATmega328P), Mega 2560 | avr8js 0.21.1 (JS) | AVR core, with 22-bit program counter support (needed by the Mega); GPIO, timers/PWM, USART, SPI, TWI (I²C), ADC, EEPROM, watchdog | parts and circuit coupling | [O] REA teardown ([simulators.md](../research/simulators.md) §3); `pc22Bits`/`eind` in `cpu.js` |
| **Raspberry Pi Pico** (RP2040), Arduino Nano RP2040 Connect | rp2040js 1.4.2 (JS) | Cortex-M0+ cores, GPIO, PIO, PWM, ADC, I²C, SPI, UART, USB-CDC, GDB server; runs MicroPython | Pico 2 (RP2350) is absent; Pico W radio | [O] teardown; no RP2350 code in the package |
| **ESP32**, ESP32-S3, ESP32-C3 (Arduino Nano ESP32 is an S3) | Espressif's QEMU fork (C) | CPU (dual-core where real), UART, interrupt matrix, GPIO strapping, flash and PSRAM, eFuse, RNG, AES/SHA/RSA, timers, TWAI (CAN), SD/MMC (ESP32), LEDC (ESP32 only), plus a virtual OpenCores **Ethernet** MAC and RGB framebuffer | **GPIO matrix/IOMUX, I²C, SPI, RMT, LEDC (S3/C3), ADC (not listed), Wi-Fi, Bluetooth, USB** | [D] Espressif `esp-toolchain-docs/qemu/README.md` feature table |
| Arduino **Uno R4 Minima** (RA4M1), **Nano 33 BLE** (nRF52840) | Renode 1.16.1 (.NET) | board files `arduino_uno_r4_minima.repl` and `arduino_nano_33_ble.repl` ship with it, plus `renesas-r7fa4m1a.repl` and `nrf52840.repl` CPU files | check peripheral coverage per sketch | [O] Renode package listing |
| **Raspberry Pi 4/5** (Linux, usually Python) | no CPU emulator needed for Python projects | gpiozero has pluggable **pin factories** (`GPIOZERO_PIN_FACTORY`, a built-in `MockFactory`) | a Triage pin factory plus shims for `RPi.GPIO`, `smbus2`, `spidev`, `pyserial` | [D] gpiozero API docs |
| Raspberry Pi full system (stretch) | QEMU `raspi3b`/`raspi4b` | BCM2838 SoC with a GPIO controller model (58 lines) | a GPIO bridge to the kernel; booting Raspberry Pi OS | [D] QEMU source (`hw/arm/raspi4b.c`, `bcm2838_gpio.h`) |

Renode 1.16.1 ships no RP2040, ESP32 or BCM283x platform files [O]. How Wokwi
simulates ESP32 Wi-Fi is unknown: its emulator loads from its web service, not
from the package [?] ([simulators.md](../research/simulators.md) §6).

## Decision

1. **Board families, in this order:**
   1. **Arduino Uno and Nano** (avr8js) in the first simulation slice (P3). The
      emulator embeds directly, so that phase can focus on the kernel and the
      one-window experience.
   2. **ESP32 family** (P4): Espressif's QEMU fork, built from source, plus
      Triage's **peripheral models** for what it lacks and a **Wi-Fi shim** that
      carries the firmware's network traffic over the emulated Ethernet into the
      virtual network gateway. ESP32 and ESP32-S3 first, then C3.
   3. **Raspberry Pi** (P4): **Pico** through rp2040js (C/C++, Arduino-Pico,
      MicroPython), and **Pi 4/5 Python projects** through the Python bridge.
      Full-system Pi emulation and Pico 2 are stretch goals (P7).
   4. **More Arduino boards** (P7): Uno R4 Minima and Nano 33 BLE through Renode.
      Nano ESP32 uses the ESP32 unit, and Nano RP2040 Connect uses rp2040js.
2. **Windows is first-class from P0.** CI builds and tests Windows and Linux on
   every push. Windows nightlies start in P0-7, and the Windows installer is the
   first one polished. macOS joins by P8. Claude's sessions keep Linux as the
   development platform.

## Consequences

Good: covers the boards the owner's courses use. ESP32 Internet-of-Things projects
become testable without hardware.

Costs:
- **A fourth fork:** Espressif's QEMU (in `engines/qemu-esp32/`), where Triage adds
  peripheral models in C. Its `esp-develop` branch is "often rebased on top of the
  upstream master branch and force-pushed" [D], so we pin a commit and merge on a
  schedule (GUIDELINES §6).
- **Wi-Fi is not emulated** by Espressif's QEMU [D]. The shim has to make
  `WiFi.begin()` behave like a real connection. A link-time shim means simulation
  builds differ slightly from hardware builds. A register-level Wi-Fi model avoids
  that but is much harder. The P4-2 spike decides.
- **Raspberry Pi Python projects** run on the laptop's own Python, paced to virtual
  time, so their timing is approximate (T0 only).
- **Windows builds** of every native engine must stay green: KiCad (MSVC + vcpkg),
  FreeCAD (LibPack or conda/pixi), QEMU (MSYS2/MinGW), ngspice and MuJoCo (CMake).
- Claude can't run Windows builds inside a cloud session. CI runs them, and the
  owner runs each milestone demo on the Windows laptop.
