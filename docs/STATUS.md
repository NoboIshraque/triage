# Status

> Read this first in every session. Update it before ending one (GUIDELINES §2).

**Last updated:** 2026-11-24 · **Phase:** planning complete. Build not started.
**Next work package:** **P0-1 Repository skeleton** (CI on Windows and Linux from the
first commit), then **P0-2 VS Code fork imported**.

## Decisions confirmed by the owner (2026-11-24)

| # | Decision | Where it's written down |
|---|---|---|
| D3 | KiCad, FreeCAD and Blender run **hidden as engines** behind Triage's own tabs | [ADR 0002](adr/0002-absorb-engines-headless.md) (Accepted) |
| D4 | Boards: **ESP32, Arduino, Raspberry Pi** | [ADR 0003](adr/0003-boards-and-windows.md), PLAN §4.7 |
| D5 | The owner's laptop runs **Windows**, so Windows is first-class from P0 | [ADR 0003](adr/0003-boards-and-windows.md), GUIDELINES §8 |
| D8 | Name: **Triage** | PLAN §5 |
| D9 | **Everything in one window**, and simulation of **everything together or any part separately** | PLAN §1, §4.3, §4.7 |

## Open questions

Nothing blocks the build. These defaults stand until the owner says otherwise:

| Topic | Default | Needed by |
|---|---|---|
| Which Raspberry Pi: Pico (microcontroller) or Pi 4/5 (Linux, usually Python)? | both: Pico through rp2040js, Pi 4/5 Python projects through the Python bridge | P4 |
| Arduino boards beyond Uno, Nano and Mega | Uno R4 Minima and Nano 33 BLE through Renode in P7 | P7 |
| Windows code-signing certificate (avoids SmartScreen warnings) | unsigned nightlies; decide before P8-2 | P8 |
| KiCad editing path (remote tools vs direct hosting) | decided by the P1-6 spike, ADR 0004 | P1 |

## Work packages

| Phase | WP | Status |
|---|---|---|
| P0 Foundations, Windows + Linux | P0-1 skeleton · P0-2 VS Code fork · P0-3 entry points + patch queue · P0-4 engine connection · P0-5 project format · P0-6 dev env · P0-7 Windows nightlies | not started |
| P1 Electronics engine + views (M1) | P1-1 … P1-7 | not started |
| P2 3D engine + enclosure from board | P2-1 … P2-5 | not started |
| P3 Simulation on Arduino (M2) | P3-1 … P3-6 | not started |
| P4 ESP32 + Raspberry Pi (M3) | P4-1 … P4-6 | not started |
| P5 In-app electronics editing | P5-1 … P5-7 | not started |
| P6 In-app 3D design (M4) | P6-1 … P6-5 | not started |
| P7 Accuracy and depth | P7-1 … P7-5 | not started |
| P8 Render, installers, v1.0 (M5) | P8-1 … P8-6 | not started |

## Research status

| Target | Breakdown | Notes |
|---|---|---|
| KiCad 10.0.8 | **complete** (debug symbols, ~158k functions placed) | [kicad.md](research/kicad.md) |
| FreeCAD 1.1 | **complete** (all 61 libraries) | [freecad.md](research/freecad.md) |
| Renode 1.16.1 | **complete** (Infrastructure.dll full inventory) | [simulators.md](research/simulators.md) |
| Blender 5.3 | static complete. Runtime API dump not permitted in session | [blender.md](research/blender.md) |
| Wokwi 4.1.0 | complete for the shipped package | [simulators.md](research/simulators.md) |
| Board emulators (ESP32, Arduino, Raspberry Pi) | package checks + vendor docs | [simulators.md](research/simulators.md) §7, [ADR 0003](adr/0003-boards-and-windows.md) |
| VS Code 1.143 | `out/` **parsed completely** (unbounded): 3 preloads, 4 bridge APIs, 34 members, 18 literal IPC channels. `extensions/`: 299 of 300 unique files parsed; none has Electron or IPC sites. Memory-bound: semantic graphs for the two 21–22 MB bundles, 15 of 28 `out/` entry files and most extension files. The ELK layout library (3 extension files) stalls REA's alias analysis. A single-file pass is running | [vscode.md](research/vscode.md) §2, §5 |

## Session log

- **2026-11-23 → 24 (planning):** Installed REA and its skill. First teardown and
  plan, briefly re-planned as an extension. The owner chose a **standalone app**
  (the extension plan moved to `NoboIshraque/triad-extension`). Added REA
  **unbounded mode** (`NoboIshraque/rea` @ `6697bfd`) and the `rea-full-breakdown`
  skill, then ran the full breakdowns, PLAN v0.2, ROADMAP (two-person team),
  GUIDELINES, ADRs 0001–0002.
- **2026-11-24 (owner's answers):** Renamed the app to **Triage**. ADR 0002
  accepted with a plain-words explanation. New ADR 0003 (ESP32, Arduino, Raspberry
  Pi; Windows first). PLAN v0.3: one window, simulation scopes (§4.7), board units,
  Windows packaging. ROADMAP re-ordered **integration-first** (P0–P8, M1–M5).
  Checked board emulators: Espressif's QEMU lacks the GPIO matrix, I²C, SPI, RMT and
  Wi-Fi; Renode ships Uno R4 Minima and Nano 33 BLE boards. VS Code workbench
  bundle analyzed (29 min 54 s).
