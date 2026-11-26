# Status

> Read this first in every session. Update it before ending one (GUIDELINES §2).

**Last updated:** 2026-11-25 · **Phase P1 Electronics engine + views: built and
checked on Linux; Windows not built yet**: GitHub Actions refused jobs for
billing from about 12:03 UTC until the owner made the repository public the
same day (see "CI" below). **Next:** the EDA workflow builds KiCad on Windows (Actions runs again since
the repository went public; the build continues from its caches over several
runs), then the owner runs the M1 demo on Windows (steps below). P1 is done when
both pass. **P0-8 is done** (Copilot works with Triage's own sign-in, the owner's
test, 2026-11-25); P0-9 stays open. ADR 0004 and ADR 0005 were accepted on 2026-11-25 (decisions
below); phase PC now runs between P3 and P4.

### P1 in one paragraph

Triage now opens KiCad projects in its own **Schematic** and **Board** tabs. A
hidden engine built from KiCad 10.0.8 (`triage-eda-engine`, loading KiCad's
pcbnew and eeschema code) records what KiCad's renderer would draw (the Stream
GAL), and Triage draws it with its own WebGL2 renderer. Its drawings match
kicad-cli's own plots of 10 demo files pixel for pixel within 2 px (coverage 1.0,
precision 0.98–1.0). In the tabs you can select, cross-probe a part between
schematic and board, move, rotate, delete, edit values and references, draw a
wire or a track, undo, redo and save. Files saved by Triage open in kicad-cli.
Renaming a net rewrites `firmware/generated/board_pins.h` in 280–305 ms, and the
code editor shows pin diagnostics and hovers. "Edit in KiCad" opens the stock
editor as a fallback, and Triage reloads a file saved elsewhere within 2 s.
KiCad's push-and-shove router runs inside the engine at 0.15–0.18 ms per
cursor move (the frame budget is 16 ms). That spike led to the editing path in
[ADR 0004](adr/0004-editing-path.md) (accepted).

### CI: back on (the repository is public since 2026-11-25)

From about 12:03 UTC on 2026-11-25 every job was refused: "The job was not
started because recent account payments have failed or your spending limit
needs to be increased" (observed: the run's annotations, the owner's
screenshot). The KiCad builds had used up the private repository's Actions
minutes (inferred). The owner made the repository **public** the same day;
Actions is free for public repositories, whose runners also have 4 cores (the
EDA build now uses them all). Anyone can now read the code and download CI's
builds (DV-24).

First runs after that (2026-11-25 18:30 UTC): CI and App green. The EDA workflow
failed twice, both fixed: on Linux the corpus found 665 rules violations on
tiny_tapeout where the golden file says 664 (the board uses system fonts the
runner lacks, so violation counts now get 1% leeway); on Windows CMake was
started through a shell, which split the vcpkg path "C:\Program Files\…" at its
space (the fork scripts now start programs directly). KiCad's dependencies are
cached for Windows (vcpkg); KiCad itself has not compiled on Windows yet.

EDA run 11 (19:50 UTC): **Linux passed everything** (build, the 54-file corpus,
the engine integration tests) and uploaded `triage-eda-linux`. Windows stopped
in its setup step: Chocolatey's server answered 504 while installing ccache
(the setup script now retries installs). The App workflow now takes the newest
engine built for its own OS, so Linux's app build carries the engine and its
smoke test runs the EDA checks in CI.

App run 44 (21:23 UTC): the Windows app passed; on Linux the engine could not
start (`libwx_gtk3u_core-3.2.so.0` missing): the Linux engine uses KiCad's
system libraries (wxWidgets, OpenCascade, libgit2, Python 3.13 …), which the
App machine lacked. The App workflow now installs them before the smoke test.
**Known issue for Linux users:** the Linux app's KiCad engine needs those
packages installed; the Linux installer must declare or bundle them (P8-2).
The Windows engine carries its DLLs.

App run 45 (22:26 UTC): **all 22 smoke checks pass on Linux in CI with the KiCad
engine** (rename → header 329 ms, a KiCad save → reload 141 ms, cross-probe,
edit and save read by kicad-cli, engine restart; 17 and 20 fps in software).
EDA run 12: **KiCad compiled on Windows (MSVC) for the first time**, in 70
minutes, and kicad-cli passed all 54 demo files on Windows; the engine's
`--load-all` report then broke on Windows paths (backslashes written into JSON
by hand). It now writes the lines with a JSON library.

The Windows compiler cache was empty: all 1,953 MSVC compiles were
"uncacheable" (EDA run 12), because KiCad forces `/Zi` debug info unless its own
`USE_CCACHE` switch is on, and only then uses `/Z7`, which ccache can cache.
The build script now turns on KiCad's switch instead of setting the launcher
itself, so later Windows builds reuse the cache instead of taking 70 minutes.

### Try P1 on Windows (the M1 owner check, once CI builds it)

1. **Actions → App →** the newest green run → artifact **triage-Windows** (it
   carries the EDA engine when the EDA workflow passed for this branch).
2. Install or unzip as for P0, open `examples/smart-fan` from a clone, click the
   Triage icon, then **Open Engineering Layout**: the Schematic and Board tabs
   show the Smart Fan.
3. Click a part (Q1), then look at the other tab: the same part is selected.
   Drag it, press **R** to rotate it, **Ctrl+S** to save.
4. **F1 → Triage: Rename Net in the Schematic**, `FAN_PWM` → `MOTOR_SPEED`:
   `firmware/generated/board_pins.h` and the diagnostics in `main.cpp` update.
5. **F1 → Triage: Benchmark Schematic and Board Views**: tell Claude the frame
   rates (the 60 fps check, DV-22).
6. **F1 → Triage: Edit in KiCad (Fallback Window)**: KiCad's editor opens the
   same file; save there and Triage's tab updates.
7. Open the saved files in your own KiCad 10 if you have it.

### P0 in one paragraph

Triage now builds as its own desktop app from VS Code 1.147.0, on Windows and
Linux, in CI. Opening a folder with a `triage.toml` shows the project's four
domains in the Triage sidebar. One command lays out Code, Schematic, Board, 3D
and Sim tabs (placeholders until P1–P3 fill them); any of them can be dragged or
popped out into a separate window. A native "hello engine" runs
behind a utility-process broker, survives being killed, and streams 114 MB/s
(Windows CI) to 237 MB/s (Linux CI) into the window. CI builds the Windows per-user installer and a portable zip.

### P0-8: register Triage on GitHub (the owner's step)

Triage signs in to GitHub, and so to Copilot, with VS Code's own registration,
inherited from the open-source code; GitHub then says "Visual Studio Code".
Triage's build has no GitHub client secret (Microsoft adds VS Code's when it
publishes VS Code), so its sign-in uses GitHub's **device flow**: a code typed
on github.com (observed in `extensions/github-authentication/src/flows.ts`).
Triage's own registration therefore needs the device flow and no secret:

1. Signed in to GitHub, open <https://github.com/settings/applications/new>
   (Settings → Developer settings → OAuth Apps → New OAuth App).
2. **Application name:** `Triage`. **Homepage URL:** the repository's URL.
   **Redirect URI** (formerly "Authorization callback URL"):
   `http://127.0.0.1/callback`; the device flow doesn't use it. Leave **Allow
   wildcard matching** off.
3. Keep **Enable Device Flow** on. Turn **Expire user access tokens** off:
   VS Code's sign-in keeps only the access token and never refreshes it
   (observed in `flows.ts`), so expiring tokens would sign the user out. Then
   **Register application**. Don't generate a client secret.
4. Give Claude the **Client ID** (it usually starts with `Ov23`). It isn't
   secret: GitHub shows it to everyone who signs in.

**Done 2026-11-24:** the owner registered the app; its client ID
`Ov23liajKvj7l41nmMfw` is in `app/patches/0004-github-sign-in-as-triage.patch`,
and the smoke test checks the packaged app carries it (and not VS Code's).
Claude's sessions can't check sign-in themselves: their network refuses
GitHub's sign-in endpoints (observed 2026-11-24).

**The owner's test (P0-8 done-when),** on a Windows build with patch 0004:

1. In Triage, click the **Accounts** icon (bottom left), pick the GitHub
   account and **Sign Out**: the earlier sign-in went through VS Code's app.
2. Sign in again (the **Sign In** button). GitHub's page should name **Triage**.
3. Send a Copilot prompt, and tell Claude whether it answers or the error.

**First result (2026-11-24, the owner, Windows build from App run 22):** in the
Agents window a prompt with the **Auto** model failed: "Auto couldn't pick a
model: the routing service is unavailable (a server error after 2 attempts)".
The message comes from GitHub's Copilot runtime (`runtime.node` in
`@github/copilot-sdk`), which asks Copilot's servers for a model
(`/models/session`); GitHub's status page showed Copilot operational at the
time (observed). The same Agents prompt worked earlier with VS Code's sign-in,
so Triage's own app is the likely cause (**inferred**). **Second result:**
after signing out and in again, the same error; the model picker offers only
"Copilot Fusion" (the automatic choice), so Copilot's servers sent no model
list either (observed by the owner). With VS Code's sign-in the same prompt
worked: **Copilot doesn't accept Triage's own sign-in** (strongly indicated;
the chat panel, Ctrl+Alt+I, not yet tried). The Copilot SDK's README documents
`gitHubToken` and BYOK providers (OpenAI, Azure, Anthropic, Google, Ollama) but
not which GitHub token types Copilot accepts (unknown).

**Why, and the fix being tried (2026-11-24):** GitHub documents the route
Triage needs: "You create a GitHub OAuth App (or GitHub App), users authorize
it, and you pass their access token to the SDK. Copilot requests are made on
behalf of each authenticated user, using their Copilot subscription"
([Copilot SDK, GitHub OAuth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth);
token types `gho_`, `ghu_`, `github_pat_` in
[Authenticate the Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)).
But VS Code's agent host labels its traffic as VS Code's integration
(`GITHUB_COPILOT_INTEGRATION_ID=code-oss`, and `Copilot-Integration-Id:
code-oss` on its own Copilot API calls). Triage's token under VS Code's label
is the likely cause (**inferred**). Patches 0005 and 0006 drop the label, so
the runtime identifies as an SDK host and Copilot authorizes against the
user's own entitlement. The owner's Windows test decides.

**Result (2026-11-25): it works.** The owner reports that Copilot now works with
Triage's own sign-in ("the copilot signup works now"), on a Windows build with
patches 0005 and 0006. Dropping VS Code's integration label was the fix
(inferred: it was the only change since the failing tests). **P0-8 is done.**
P8-7 item (2) still needs GitHub's terms for Copilot in Triage checked.

If that still fails, documented routes remain: a **GitHub App** instead of the
OAuth App (GitHub calls it "recommended for new projects"); a **fine-grained
personal access token** with the "Copilot Requests" permission, which the
Copilot runtime's own messages name as supported (observed in
`runtime.node`); reusing an existing **GitHub CLI / Copilot CLI** login (the
runtime supports it); or AI models with the user's **own API key**.

**Unknown:** whether GitHub Copilot
accepts a sign-in from an app other than VS Code. Other unofficial Copilot
clients reuse official GitHub app IDs rather than their own, which hints it may
not (inferred). The P0-8 test settled it: it does (result above).

### Try it on Windows (the P0-7 owner check)

1. Open the repository's **Actions** tab → workflow **App** → the newest green
   run → artifact **triage-Windows** (kept 1 day). The **Nightly** workflow
   builds from the default branch at 03:17 UTC after any commits that day;
   its artifact is **triage-Windows-nightly** (kept 3 days).
2. Unzip it. Either run `TriageUserSetup-x64-….exe` (per-user, no admin) or
   unzip `Triage-win32-x64-….zip` and start `Triage\Triage.exe`. Windows
   SmartScreen will warn: the build is unsigned (decision due before P8).
3. Open a folder with a `triage.toml` (for example `examples/smart-fan` from a
   clone), click the Triage icon at the top of the activity bar, then **Open
   Engineering Layout** and **Benchmark Hello Engine**.
4. Try the separate windows: drag a tab (say **Schematic**) out of the window,
   click the window button at the right of the tab bar, or click **Open in
   Separate Windows** in the Triage sidebar.
5. Copilot is hidden, not removed. To use it: **File → Preferences → Settings**,
   search **Disable AI Features**, untick it; the Sign In button and Copilot
   icon return, and **Ctrl+Alt+I** opens the chat (checked on a local build;
   the owner signed in with GitHub and ran an agent prompt on Windows,
   2026-11-24).

The owner launched it on 2026-11-24, which completes P0-7. Tell Claude what felt wrong.

## Decisions confirmed by the owner (2026-11-24)

| # | Decision | Where it's written down |
|---|---|---|
| D3 | KiCad, FreeCAD and Blender run **hidden as engines** behind Triage's own tabs | [ADR 0002](adr/0002-absorb-engines-headless.md) (Accepted) |
| D4 | Boards: **ESP32, Arduino, Raspberry Pi** | [ADR 0003](adr/0003-boards-and-windows.md), PLAN §4.7 |
| D5 | The owner's laptop runs **Windows**, so Windows is first-class from P0 | [ADR 0003](adr/0003-boards-and-windows.md), GUIDELINES §8 |
| D8 | Name: **Triage** | PLAN §5 |
| D9 | **Everything in one window**, and simulation of **everything together or any part separately** | PLAN §1, §4.3, §4.7 |
| D9 (added) | Any tab can be **dragged or popped out into a separate Triage window**; one window stays the default | PLAN §1, [DV-14](DEVIATIONS.md) |
| — | Claude's sessions **may run Electron** (build and open the app, not only in CI) | CLAUDE.md, GUIDELINES §10, [DV-07](DEVIATIONS.md) |
| — | VS Code's built-in **Copilot chat is hidden** by default | `app/src/vs/triage/browser/triage.contribution.ts`, [choices](DEVIATIONS.md#choices-the-plan-left-open) |
| — | P0 **merged into the default branch** (PR #1); nightlies run from it | `.github/workflows/nightly.yml` |
| — | Triage gets **its own GitHub sign-in** (OAuth app) now, before P1 | ROADMAP P0-8, [DV-15](DEVIATIONS.md) |
| — | Triage's logo: the owner's T in **K3 Slate**; Triage's dark themes show it **reversed** (light T, slate traces; option C) | `scripts/branding/icons.py`, `docs/brand/`, [choices](DEVIATIONS.md#choices-the-plan-left-open) |
| — | **No VS Code name or logo** in Triage now (P0-9), and a **public release checklist** before builds are shared (P8-7) | ROADMAP P0-9, P8-7, [DV-16](DEVIATIONS.md) |
| — | GitHub Actions **minutes are no concern** (the owner's GitHub student account): the App workflow runs on every push except documentation-only ones | [DV-08](DEVIATIONS.md) |
| D10 (2026-11-25) | **Editing path: direct hosting.** KiCad's code does the routing, checks and saving inside the engine; Triage draws the tools (owner: "I'm guessing the proposed one is better") | [ADR 0004](adr/0004-editing-path.md) (Accepted) |
| — (2026-11-25) | The repository is **public** (Actions had stopped for billing; public repositories run Actions free) | [DV-24](DEVIATIONS.md) |
| D11 (2026-11-25) | **Phone and tablet companion accepted**: a relay, "whichever is the most secure" (end-to-end sealed, holds no keys); the phone app on **GitHub Pages**, the owner's domain later; **iOS 26.4+** for the direct path; phase **PC between P3 and P4**; **View only or View and edit asked each time**, and a view-only phone can be given edit permission during the session | [ADR 0005](adr/0005-phone-companion.md) (Accepted), PLAN §4.16, ROADMAP PC, [DV-23](DEVIATIONS.md) |

## Deviations from the plan

Every place the build differs from the plan is logged in
[DEVIATIONS.md](DEVIATIONS.md) (24 entries, DV-01 … DV-24, plus choices the plan left open), so the
owner can compare the final build with the plan.

## Open questions

Nothing blocks the build. These defaults stand until the owner says otherwise:

| Topic | Default | Needed by |
|---|---|---|
| Remove the hidden Copilot extension from builds entirely? It is 56 MB of the app; hidden and disabled, it does nothing | kept (one setting turns VS Code's AI features back on) | P8 (installer size) |
| Which Raspberry Pi: Pico (microcontroller) or Pi 4/5 (Linux, usually Python)? | both: Pico through rp2040js, Pi 4/5 Python projects through the Python bridge | P4 |
| Arduino boards beyond Uno, Nano and Mega | Uno R4 Minima and Nano 33 BLE through Renode in P7 | P7 |
| Windows code-signing certificate (avoids SmartScreen warnings) | unsigned nightlies; decide before P8-2 | P8 |

## Work packages

| Phase | WP | Status |
|---|---|---|
| P0 Foundations, Windows + Linux | P0-1 skeleton · P0-2 VS Code fork · P0-3 entry points + patch queue · P0-4 engine connection · P0-5 project format · P0-6 dev env · P0-7 Windows nightlies · P0-8 own GitHub sign-in · P0-9 branding sweep | P0-1 … P0-7 **done**; **P0-8 done** 2026-11-25 (Copilot works with Triage's own sign-in); **P0-9 in progress** |
| P1 Electronics engine + views (M1) | P1-1 KiCad fork builds · P1-2 headless engine · P1-3 Stream GAL · P1-4 views · P1-5 pin map · P1-6 edits + spike · P1-7 fallback | **all built and checked on Linux** (P1-3 and P1-4 with DV-21, DV-22; ADR 0004 proposed); **Windows not built yet** (CI down); the owner's M1 run on Windows next |
| P2 3D engine + enclosure from board | P2-1 … P2-5 | not started |
| P3 Simulation on Arduino (M2) | P3-1 … P3-6 | not started |
| PC Phone and tablet companion ([ADR 0005](adr/0005-phone-companion.md)) | PC-1 … PC-7 | not started (after P3, before P4) |
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
- **2026-11-24 (the owner's answers):**
  - **Merged** P0 into the default branch (PR #1), so nightlies run.
  - **Electron OK'd** in Claude's sessions. The first local build packaged in
    4.5 minutes and the app ran under Xvfb.
  - **Copilot chat hidden** by default (`chat.disableAIFeatures`, and the
    secondary side bar it lived in starts closed). The "agentHostManagement
    timed out" error no longer shows; the smoke test checks the chat stays hidden.
  - **Minutes no concern:** the App workflow now runs on every push except
    documentation-only ones.
  - The owner ran the **Windows build** (P0-7 done), turned the AI features
    back on, signed in with GitHub and ran a Copilot agent prompt: it works.
  - GitHub called the app "Visual Studio Code" at sign-in: Triage uses VS
    Code's GitHub registration from the open-source code. The owner chose to
    give Triage **its own GitHub sign-in before P1**: new WP **P0-8** (DV-15).
  - The owner asked what else could get Triage flagged once shared. Six items
    became the **public release checklist (P8-7)**; the owner asked for the
    trademark item now: **P0-9, branding sweep** (DV-16). It found VS Code's
    logo (`vscode-icon.svg`, the Agents window), Code-OSS's icon and watermark,
    331 of 32,964 workbench strings and 104 strings in 27 built-in extensions
    naming VS Code (observed in the packaged Linux build).
  - **Triage's logo:** the owner sketched a T with PCB traces; Claude drew it,
    replaced the busy sketched traces with a three-track bus at the owner's
    request, made the gaps equal, and the owner chose **K3 Slate `#1e293b`**
    from 16 shades. Every icon now comes from `scripts/branding/icons.py`
    (master files in `docs/brand/`). K3 nearly disappears on dark backgrounds,
    so the owner chose option C: Triage's dark themes (the default) show the
    reversed logo in the title bar and the other places VS Code shows its
    logo; the app icon and installer stay K3. The smoke test checks it.
  - The "workflow run failed" notifications the owner saw come from App runs
    2, 8, 9 and 10 and CI run 7, the failures this session fixed (DV-11, DV-13,
    the swap-file disk issue).
- **2026-11-25 (phone companion planned, the owner's request; docs only):**
  researched how WhatsApp, Signal (source plus a REA breakdown of Signal Desktop
  8.36.0), VS Code tunnels, KDE Connect and Sunshine link a second device, and
  what phone browsers can do ([companion.md](research/companion.md), ledger
  round 4). Proposed [ADR 0005](adr/0005-phone-companion.md): an installable web
  app that draws Triage's own data (display lists, tessellations, simulation
  state), WebTransport on the same Wi-Fi with the laptop's certificate pinned by
  the QR, an optional relay elsewhere, a six-digit code plus **Allow** on the
  laptop, per-phone keys and view or edit permission. Added PLAN §4.16, ROADMAP
  phase PC (PC-1 to PC-7) and DV-20. Waiting for the owner (open question above).
- **2026-11-25 (P1, first session).** All of P1 built, checked on Linux:

  | WP | Done when | Evidence |
  |---|---|---|
  | P1-1 | kicad-cli from our tree passes the demos corpus on both OSes | Linux: all 54 root schematics and boards of KiCad's 36 demos (netlist, ERC, DRC, SVG), golden `engines/eda/tests/golden/corpus.json`. **Windows: not built** (CI down) |
  | P1-2 | The engine loads all demos and answers API queries | Linux: the same 54 files through `--load-all`; the largest (Jetson) 548,549 groups in 12 s; engine integration tests 8/8 (open, display lists, queries, selection, edits, undo, save, reload, router, restart) |
  | P1-3 | Display lists match OpenGL GAL (DV-21) | compared with kicad-cli's plots instead: 10 files, coverage 1.0, precision 0.98–1.0 (`compare.mjs`); bitmaps included |
  | P1-4 | 60 fps; pixel compare against kicad-cli | pixel compare as P1-3; frame rates recorded under software GL only (9.7 and 11.8 fps, DV-22): the owner's GPU run decides |
  | P1-5 | Net rename updates the header and diagnostics within 2 s | 280–305 ms in the packaged app (smoke test, 22/22 checks pass on Linux) |
  | P1-6 | Saved files open in stock KiCad; spike + ADR 0004 | kicad-cli reads Triage's saved board and schematic (smoke and engine tests); router 0.15–0.18 ms per move; [ADR 0004](adr/0004-editing-path.md) proposed |
  | P1-7 | A KiCad save shows in Triage within 2 s | the smoke test saves with kicad-cli and times the reload |

  Found along the way: VS Code's IPC turned nested buffers into JSON (replies
  are now packed); a command used VS Code's service accessor after an `await`
  (cross-probe did nothing); our own save hid an external save made within 3 s
  (the views now compare the file's modification time). GitHub Actions stopped
  starting jobs at about 12:03 UTC (above). Known issues: KiCad's share data
  (libraries, schemas) isn't staged yet, so the fallback editors start without
  libraries; `LayerName()` has no names for a few virtual layers ("In559.Cu" for
  LAYER_DANGLING); the P1 `Route` request takes all cursor moves in one call
  (P6 makes it a session, ADR 0004).
- **2026-11-25 (owner's decisions).** ADR 0004 accepted (direct hosting), after a
  plain-words comparison of the two paths. ADR 0005 accepted with a relay (the
  most secure design: sealed end to end, no keys on the relay), GitHub Pages then
  the owner's domain, iOS 26.4+, phase PC between P3 and P4 (DV-23), and the
  permission asked each time the laptop shares, changeable during a session.
  The owner runs the P0-8 Copilot test on 2026-11-26.
- **2026-11-25 (CI billing).** Actions refused every job for billing (the owner's
  screenshot of the annotations). The owner made the repository public; the EDA
  workflow now uses the public runners' 4 cores (DV-24).
- **2026-11-25 (P0-8 done).** The owner reports Copilot works with Triage's own
  GitHub sign-in on Windows (patches 0004–0006). The open question on Copilot
  fallbacks is closed.
