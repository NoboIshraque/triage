# Status

> Read this first in every session. Update it before ending one (GUIDELINES §2).

**Last updated:** 2026-11-24 · **Phase:** P0 Foundations.
**Done:** **P0-1 Repository skeleton** (CI green on Windows and Linux).
**Current work package:** **P0-2 VS Code fork imported**.

## Decisions confirmed by the owner (2026-11-24)

| # | Decision | Where it's written down |
|---|---|---|
| D3 | KiCad, FreeCAD and Blender run **hidden as engines** behind Triage's own tabs | [ADR 0002](adr/0002-absorb-engines-headless.md) (Accepted) |
| D4 | Boards: **ESP32, Arduino, Raspberry Pi** | [ADR 0003](adr/0003-boards-and-windows.md), PLAN §4.7 |
| D5 | The owner's laptop runs **Windows**, so Windows is first-class from P0 | [ADR 0003](adr/0003-boards-and-windows.md), GUIDELINES §8 |
| D8 | Name: **Triage** | PLAN §5 |
| D9 | **Everything in one window**, and simulation of **everything together or any part separately** | PLAN §1, §4.3, §4.7 |

## Decisions made in build sessions (the owner can override)

| Decision | Why | Where |
|---|---|---|
| Forks are **not committed**: `upstream.json` pins tag + commit, the build checks it out into `upstream/` (git-ignored) and applies patches and overlays | VS Code 1.147.0 alone is 411 MB / 21,462 files; KiCad and FreeCAD are larger. This is VSCodium's proven model, and it is what "re-applies cleanly onto a fresh upstream checkout" (P0-3) needs | GUIDELINES §6, PLAN §4.12, [app/README.md](../app/README.md) |
| VS Code pinned at **1.147.0** (tagged 2026-11-17) | latest release when P0-2 started; the research teardown used 1.143 (VSCodium) | `app/upstream.json` |
| Fork scripts are **Node** (`scripts/forks/*.mjs`, `app/build.mjs`); `build.sh` and `build.ps1` only start them | one implementation for Windows and Linux (GUIDELINES §8) | `scripts/forks/`, `app/` |
| Open VSX gallery keys as VSCodium uses them, and Triage's own Windows app IDs | Triage installs beside VS Code without clashing | `app/product.json` |

## Open questions

Nothing blocks the build. These defaults stand until the owner says otherwise:

| Topic | Default | Needed by |
|---|---|---|
| **May Claude run Electron in its cloud sessions?** Building VS Code downloads Electron and other prebuilt helpers, and CLAUDE.md says not to run downloaded third-party binaries without the owner's OK | no: the app is built and smoke-tested only in CI (GitHub's machines). Saying yes makes P0-3's UI work faster, because Claude could open the app and take screenshots locally | P0-3 |
| GitHub Copilot ships **built in** to VS Code 1.147 (`extensions/copilot`). Keep, hide or remove it in Triage? (VSCodium removes it) | keep upstream's for now | P0-7 |
| GitHub Actions minutes: the repository is private, so runners have 2 cores and Windows minutes count double. The app build runs only when `app/` changes | that trigger rule, plus a nightly from P0-7 | P0-7 |
| Which Raspberry Pi: Pico (microcontroller) or Pi 4/5 (Linux, usually Python)? | both: Pico through rp2040js, Pi 4/5 Python projects through the Python bridge | P4 |
| Arduino boards beyond Uno, Nano and Mega | Uno R4 Minima and Nano 33 BLE through Renode in P7 | P7 |
| Windows code-signing certificate (avoids SmartScreen warnings) | unsigned nightlies; decide before P8-2 | P8 |
| KiCad editing path (remote tools vs direct hosting) | decided by the P1-6 spike, ADR 0004 | P1 |

## Work packages

| Phase | WP | Status |
|---|---|---|
| P0 Foundations, Windows + Linux | **P0-1 skeleton: done** · P0-2 VS Code fork: in progress · P0-3 entry points + patch queue · P0-4 engine connection · P0-5 project format · P0-6 dev env · P0-7 Windows nightlies | in progress |
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
| VS Code 1.143 | **complete** (unbounded, rounds 2–3): every `out/` JS file parsed, and all 28 entry files have static facts and semantic graphs. 3 preloads, 4 bridge APIs, 34 members, 18 literal IPC channels. `extensions/`: 298 of 300 unique files have static facts and semantic graphs; none has Electron or IPC sites. Unknown: semantic graphs of the two 21–22 MB bundles (over 6 GiB of worker heap), `typescript.js` (facts over the ~1 GiB transfer ceiling), a generated zenuml parser (over 6 GiB), and the 3 ELK layout files (stall REA's alias analysis) | [vscode.md](research/vscode.md) §2, §5 |

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
- **2026-11-24 (VS Code breakdown finished):** The built-in extensions ran in six
  batches. Then every file whose semantic graph a shared budget had dropped was
  re-run on its own (round 3, 272 runs in 1 h 27 min). Found and fixed two errors:
  - the `out/` semantic-graph count was 13 of 28 after round 2, not 22;
  - an inherited `NODE_OPTIONS` overrode the heap flag in REA's launcher
    (fixed in `NoboIshraque/rea@84e2b99`).

  The ELK layout library stalls REA's alias analysis, so it is recorded as unknown.
  Per-file results: `docs/research/data/vscode-round3.tsv`.
- **2026-11-24 (build starts, P0-1 done):** Repository skeleton: folders from PLAN
  §4.12 with READMEs; pnpm 10 workspace + Turborepo with `@triage/cli` (help and
  version, Vitest tests including one that runs the built binary); Cargo workspace
  (Rust 1.97.0 pinned) with a placeholder `triage-model`; CMake presets (`dev`,
  `release`, `ci`) for Triage's own C++, seeded with the P0-4 hello engine and 3
  CTest tests; Prettier, ESLint, rustfmt, clippy and clang-format 18 (Ubuntu's,
  not a downloaded wheel). CI run 1 was green on all 8 jobs (format, then
  TypeScript, Rust and native C++ on `ubuntu-24.04` and `windows-2025`).
  Notes for later WPs:
  - TypeScript stays on **6.0**: typescript-eslint supports `< 6.1`, and the
    latest TypeScript is 7 (the native port). VS Code itself pins
    `@typescript/typescript6`.
  - pnpm refuses releases younger than a week (`minimumReleaseAge`). It worked:
    vitest 5.1.1 (6 days old) was refused and 5.1.0 installed.
  - The Windows runners ship an unrelated `ccache.exe` (Strawberry Perl), which
    CMake picked up as a launcher. The `ci` preset turns ccache off until P0-6
    adds a cached one.
  - `ilammy/msvc-dev-cmd@v1` targets Node 20, so GitHub forces it onto Node 24
    with a warning. It works.
