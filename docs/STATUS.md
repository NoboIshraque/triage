# Status

> Read this first in every session. Update it before ending one (GUIDELINES §2).

**Last updated:** 2026-11-24 · **Phase P0 Foundations: done** (one owner check
left, below). **Next:** start **P1 Electronics engine + views** in a new session
(P1-1, KiCad fork builds).

### P0 in one paragraph

Triage now builds as its own desktop app from VS Code 1.147.0, on Windows and
Linux, in CI. Opening a folder with a `triage.toml` shows the project's four
domains in the Triage sidebar. One command lays out Code, Schematic, Board, 3D
and Sim tabs (placeholders until P1–P3 fill them); any of them can be dragged or
popped out into a separate window. A native "hello engine" runs
behind a utility-process broker, survives being killed, and streams 114 MB/s
(Windows CI) to 237 MB/s (Linux CI) into the window. CI builds the Windows per-user installer and a portable zip.

### Try it on Windows (the P0-7 owner check)

1. Open the repository's **Actions** tab → workflow **App** → the newest green
   run on branch `claude/intelligent-allen-bqg63r` → artifact **triage-Windows**
   (kept 1 day; nightlies, kept 3 days, start once this branch is merged into
   the default branch).
2. Unzip it. Either run `TriageUserSetup-x64-….exe` (per-user, no admin) or
   unzip `Triage-win32-x64-….zip` and start `Triage\Triage.exe`. Windows
   SmartScreen will warn: the build is unsigned (decision due before P8).
3. Open a folder with a `triage.toml` (for example `examples/smart-fan` from a
   clone), click the Triage icon at the top of the activity bar, then **Open
   Engineering Layout** and **Benchmark Hello Engine**.
4. Try the separate windows: drag a tab (say **Schematic**) out of the window,
   click the window button at the right of the tab bar, or click **Open in
   Separate Windows** in the Triage sidebar.

Tell Claude what felt wrong. P0-7 is done when you have launched it.

## Decisions confirmed by the owner (2026-11-24)

| # | Decision | Where it's written down |
|---|---|---|
| D3 | KiCad, FreeCAD and Blender run **hidden as engines** behind Triage's own tabs | [ADR 0002](adr/0002-absorb-engines-headless.md) (Accepted) |
| D4 | Boards: **ESP32, Arduino, Raspberry Pi** | [ADR 0003](adr/0003-boards-and-windows.md), PLAN §4.7 |
| D5 | The owner's laptop runs **Windows**, so Windows is first-class from P0 | [ADR 0003](adr/0003-boards-and-windows.md), GUIDELINES §8 |
| D8 | Name: **Triage** | PLAN §5 |
| D9 | **Everything in one window**, and simulation of **everything together or any part separately** | PLAN §1, §4.3, §4.7 |
| D9 (added) | Any tab can be **dragged or popped out into a separate Triage window**; one window stays the default | PLAN §1, [DV-14](DEVIATIONS.md) |

## Deviations from the plan

Every place the build differs from the plan is logged in
[DEVIATIONS.md](DEVIATIONS.md) (14 entries, DV-01 … DV-14, plus choices the plan left open), so the
owner can compare the final build with the plan.

## Open questions

Nothing blocks the build. These defaults stand until the owner says otherwise:

| Topic | Default | Needed by |
|---|---|---|
| **May Claude run Electron in its cloud sessions?** Building VS Code downloads Electron and other prebuilt helpers, and CLAUDE.md says not to run downloaded third-party binaries without the owner's OK | no: the app is built and smoke-tested only in CI, with screenshots in the artifacts (that worked for all of P0, at about 25 minutes per round trip). Saying yes would speed up UI work in P1-4 | P1-4 |
| **GitHub Copilot and agents are built into VS Code 1.147**: the screenshots show its chat panel open on the right, a Copilot sign-in prompt, and a startup error ("agentHostManagement timed out"). Keep, hide or remove? | recommendation: hide by default in P1 (product defaults) and remove later if you prefer; kept as upstream ships it so far | P1 |
| **Merge this branch into the default branch?** Scheduled nightlies run only from the default branch | Claude opens a pull request when you ask | before nightlies |
| GitHub Actions minutes and storage: private repository, 2-core runners, Windows minutes count double. An App build takes about 25 minutes per OS (Windows ~25, the installer adds ~7); the Windows artifacts are about 660 MB | App builds only when the app's inputs change, nightlies only after commits, 1–3 days retention | now |
| Which Raspberry Pi: Pico (microcontroller) or Pi 4/5 (Linux, usually Python)? | both: Pico through rp2040js, Pi 4/5 Python projects through the Python bridge | P4 |
| Arduino boards beyond Uno, Nano and Mega | Uno R4 Minima and Nano 33 BLE through Renode in P7 | P7 |
| Windows code-signing certificate (avoids SmartScreen warnings) | unsigned nightlies; decide before P8-2 | P8 |
| KiCad editing path (remote tools vs direct hosting) | decided by the P1-6 spike, ADR 0004 | P1 |

## Work packages

| Phase | WP | Status |
|---|---|---|
| P0 Foundations, Windows + Linux | P0-1 skeleton · P0-2 VS Code fork · P0-3 entry points + patch queue · P0-4 engine connection · P0-5 project format · P0-6 dev env · P0-7 Windows nightlies | **done** (P0-7: owner check pending) |
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
- **2026-11-24 (P0 done, first build session).** Every P0 work package, with
  the evidence for its "done when" (ROADMAP P0):

  | WP | Done when | Evidence |
  |---|---|---|
  | P0-1 | CI green on Windows and Linux | CI run 1: all 8 jobs green |
  | P0-2 | Running builds on Linux and Windows; a Playwright smoke test opens a window on both | App runs 10–11: build, package, engines, smoke test 10/10 with screenshots on **Windows and Linux** (Linux: the whole job in 10 minutes) |
  | P0-3 | Triage sidebar and layout visible; the patch queue re-applies onto a fresh upstream checkout | smoke checks (sidebar, five tabs in five groups, walkthrough); `check-patches` step on every App run; 6 patch-queue tests |
  | P0-4 | ≥ 100 MB/s of binary frames on Windows and Linux; a killed engine shows "reconnecting" and recovers | engine → broker: 543–612 MB/s (Windows CI), 1.2–1.7 GB/s (Linux); into the window: 114–115 MB/s (Windows), 131–237 MB/s (Linux) across smoke runs. Kill → reconnecting → recovered in the engine tests (both OSes) and the smoke test |
  | P0-5 | `examples/smart-fan` shows the four domains; Rust and TS unit tests | smoke check and screenshot; 12 Rust tests; addon and JSON Schema tests on both OSes |
  | P0-6 | A fresh container and a fresh Windows runner build following only the scripts | CI jobs `setup-linux` (fresh `ubuntu:24.04` container) and `setup-windows` green in run 14 |
  | P0-7 | The owner downloads the nightly and launches it on Windows | Windows installer and zip built and uploaded (run 10); **waiting for the owner** |

  Built along the way: the pinned-checkout fork model with overlays and a
  patch queue (3 patches), `app/build.mjs` (fetch, prepare, install,
  typecheck, package, engines, dist), Triage's workbench code in
  `app/src/vs/triage/`, the C++ hello engine with Unix-socket and named-pipe
  transports, the Rust project model with its napi addon, setup scripts for
  both systems, and the App and Nightly workflows.

  **Known issues for the next phases:**
  - Into-window throughput on Windows (114 MB/s) is barely above target. VS Code's IPC
    channel is the narrow part (285 MB/s reach the broker). P1-3/P1-4 should
    give display lists a direct MessagePort with transferable buffers.
  - Upstream's Copilot/agent UI shows on first start, with an
    "agentHostManagement timed out" error (open question above).
  - The installer shows VS Code's wizard images and MIT license page (P8-2).
  - Builds have no source maps (DV-13); stack traces point into bundles.
  - Copilot ships 51 MB of extension in the app; removing it shrinks builds.

  - Layout sizes passed to `applyLayout` were lost when the tabs opened (the
    top row came out squeezed three times); the command now evens the groups
    out afterwards, and the smoke test checks the row heights.

  **Corrections:** an early commit said the first App run "sat in apt-get for
  over ten minutes"; it had been about two minutes (misread timestamps). The
  Windows build failure on `windows-2025` is attributed to missing Spectre
  libraries by inference (DV-12), not from the log. The first Linux hangs were
  blamed on memory and that held (measured, DV-13), but runs 9–10 then died on
  a full disk caused by the swap file added as a memory fix.
- **2026-11-24 (separate windows, the owner's request):** Triage's tabs can
  leave the main window: drag a tab out, click **Open in a Separate Window** on
  the tab bar, or run **Triage: Open Engineering Views in Separate Windows**
  (Code stays, the other four move). Views that are already open move rather
  than being copied. The smoke test checks it; PLAN §1 and D9 now say so (DV-14).
