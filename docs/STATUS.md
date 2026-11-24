# Status

> Read this first in every session. Update it before ending one (GUIDELINES §2).

**Last updated:** 2026-11-24 · **Phase:** planning complete. Build not started.
**Next work package:** **P0-1 Repository skeleton**, then **P0-2 VS Code fork imported**.

## Open questions for the owner

| # | Question | Default if unanswered |
|---|---|---|
| D3 | Confirm: absorb KiCad, FreeCAD and Blender as headless engines ([ADR 0002](adr/0002-absorb-engines-headless.md)) | proceed as proposed |
| D4 | Which boards do your courses use (Arduino Uno, Pico, ESP32, STM32...)? | Uno + Pico first |
| D5 | Your laptop OS (first installer to polish) | Linux builds first; Windows/macOS from CI |
| D8 | Product name | "Triad" |

## Work packages

| Phase | WP | Status |
|---|---|---|
| P0 Foundations | P0-1 skeleton · P0-2 VS Code fork · P0-3 Triad entry points · P0-4 project format · P0-5 dev env · P0-6 nightlies | not started |
| P1 Companion suite | P1-1 … P1-6 | not started |
| P2 Simulation slice (M1) | P2-1 … P2-6 | not started |
| P3 EDA engine + viewing | P3-1 … P3-5 | not started |
| P4 In-app electronics (M2) | P4-1 … P4-6 | not started |
| P5 CAD engine + 3D (M3) | P5-1 … P5-7 | not started |
| P6 Simulation depth | P6-1 … P6-6 | not started |
| P7 Render + v1.0 (M4) | P7-1 … P7-5 | not started |

## Research status

| Target | Breakdown | Notes |
|---|---|---|
| KiCad 10.0.8 | **complete** (debug symbols, ~158k functions placed) | [kicad.md](research/kicad.md) |
| FreeCAD 1.1 | **complete** (all 61 libraries) | [freecad.md](research/freecad.md) |
| Renode 1.16.1 | **complete** (Infrastructure.dll full inventory) | [simulators.md](research/simulators.md) |
| Blender 5.3 | static complete. Runtime API dump not permitted in session | [blender.md](research/blender.md) |
| Wokwi 4.1.0 | complete for the shipped package | [simulators.md](research/simulators.md) |
| VS Code 1.143 | see [vscode.md](research/vscode.md) for the unbounded run status | 21–22 MB bundles take the longest |

## Session log

- **2026-11-23 → 24 (planning):** Installed REA and its skill. First teardown and
  plan, briefly re-planned as an extension. The owner chose a **standalone app**
  (the extension plan moved to `NoboIshraque/triad-extension`). Added REA
  **unbounded mode** (`NoboIshraque/rea` @ `6697bfd`) and the `rea-full-breakdown`
  skill, then ran the full breakdowns, PLAN v0.2, ROADMAP (two-person team),
  GUIDELINES, ADRs 0001–0002.
