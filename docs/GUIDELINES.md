# How we build Triage (the owner + Claude)

Triage is built by two: **the owner** and **Claude**, working in Claude Code
sessions. These guidelines make every session productive on its own and keep the
project coherent across many sessions.

## 1. Roles

| The owner | Claude |
|---|---|
| Product direction and priorities | Implementation, tests, documentation |
| Decisions (confirms ADRs, answers open questions) | Proposes options with a recommendation; writes ADRs |
| Tries nightly builds on their **Windows** laptop and reports what felt wrong | Keeps builds green on Windows and Linux, and `STATUS.md` current |
| Engineering-student perspective: what courses and boards need (ESP32, Arduino, Raspberry Pi) | Research with REA when integrating engines |
| Merges pull requests | Opens pull requests when a work package is done (only when asked) |

## 2. Session routine

**Start (first minutes)**
0. Merge the default branch into the session's branch (CLAUDE.md, "Branches").
1. Read `CLAUDE.md`, then `docs/STATUS.md`: the current work package (WP), blockers and open questions.
   Then `docs/CHECKS.md`: checks the owner marked done or wrote results into.
2. Read that WP in `docs/ROADMAP.md`, plus the PLAN sections and ADRs it touches.
3. State the goal and "done when" in two or three lines. If a decision the WP
   depends on is open, ask before building.

**During**
- Work on the session's assigned branch. Use small Conventional Commits
  (`feat(sim): …`, `fix(eda): …`).
- Keep `main`-quality: the build stays green and tests pass at every push.
- **Commit and push at each meaningful step.** Cloud sessions can restart (see §10),
  and anything not pushed can be lost.

**End**
1. Update `docs/STATUS.md`: WP status, what's done, what's next, known issues.
2. Add or update the owner's checks in `docs/CHECKS.md` (detailed steps; only the
   owner marks a check done).
3. Push.
4. At the end of a phase: merge it into the default branch through a pull
   request once CI is green (CLAUDE.md, "Branches").
5. Tell the owner what now works, which checks in `docs/CHECKS.md` are new or
   changed, what's next, and any questions.

**One phase per session.** The owner starts each phase (P0, P1, …) in a new
session. A session works through its phase's WPs in order. When the phase is
done, it updates `STATUS.md` (phase done, next phase), pushes, merges into the
default branch, and tells the owner plainly: "Phase Px is done and merged; start
Py in a new session." A session that can't finish its phase records where it
stopped in `STATUS.md` and doesn't merge; the next session continues that
phase.

## 3. Work package template

```markdown
### <ID> <title>
Goal: one sentence.
Deliverable: what exists afterwards (code, UI, docs).
Done when: observable checks (tests, demo steps).
Depends on: WPs, decisions.
Notes: risks, references (PLAN §, ADR, research doc).
```

A WP is **1–3 sessions**. If one grows beyond that, split it in `ROADMAP.md`
before continuing.

## 4. Definition of done (every WP)

- The "done when" checks pass and are automated where possible.
- New code has tests. Engine integrations have golden files.
- CI is green on **Windows and Linux** (macOS from P8).
- **One window:** the feature works inside Triage. Needing the stock KiCad or
  FreeCAD window is allowed only where the ROADMAP lists the fallback.
- **Buttons and mouse first** (the owner, 2026-11-27; PLAN §1, D13): every user
  action the WP adds has a button, a menu entry or a mouse gesture in Triage's
  window, and the smoke test uses it. A command-palette entry, a keyboard
  shortcut or a `triage` CLI command may come in addition, never instead. The
  CLI is for CI and scripted grading.
- **Milestone WPs:** the owner has run the exit demo on their Windows laptop
  (a check in `docs/CHECKS.md`, which the owner marks done).
- No performance budget from PLAN §4.14 regresses (benchmarks for touched areas).
- Docs updated: user-facing notes, `STATUS.md`, and an ADR if a decision was made or changed.
- **Deviations logged:** anything built differently from PLAN, ROADMAP,
  GUIDELINES or an ADR has an entry in `DEVIATIONS.md` (plan said · built · why ·
  docs updated? · revisit), added in the same commit.

## 5. Branches and pull requests

- One assigned branch per session. Never push to the default branch (the
  project's main branch, named in CLAUDE.md) directly.
- A session starts by merging the default branch into its own branch.
- When a phase is done and CI is green on Windows and Linux, the session opens a
  pull request into the default branch and merges it (the owner's standing
  permission, 2026-11-26; CLAUDE.md "Branches"). Unfinished phases, red CI and
  conflicts that need a decision aren't merged.
- Parallel sessions on **independent** WPs are fine, with separate branches and
  no shared files beyond `STATUS.md` (merge that by hand).

## 6. Forks: VS Code, KiCad, FreeCAD, Espressif QEMU

All four follow the same rules:
- `upstream.json` pins an upstream release (tag **and** commit).
  `scripts/forks/fetch.mjs` checks out exactly that commit into `upstream/`,
  untouched and **not committed** (git-ignored), and refuses a tag that moved.
  The trees are large (VS Code 1.147.0: 411 MB, 21,462 files), so this repository
  holds only the pin and Triage's changes.
- `patches/`: numbered `*.patch` files with **small** changes to upstream
  files, such as registration hooks or new backends. `scripts/forks/patches.mjs`
  applies them in order, refreshes them from edits in the checkout (each upstream
  file belongs to one patch), and checks that they apply onto a fresh checkout.
  For the app: `node app/build.mjs refresh-patches | check-patches`.
- Overlay folders: files that replace upstream files or add new ones at the
  same path. For the app: `app/src/` (Triage's code under `src/vs/triage/`) and
  `app/resources/` (branding). Its `product.json` keys merge over upstream's.
- Never edit `upstream/` by hand: the build resets it to the pinned commit
  (`app/build.mjs prepare` refuses to discard edits it didn't make).
- **Triage-only code lives in its own folders** (`app/src/vs/triage/`,
  `engines/eda/triage/`, `engines/cad/triage/`, `engines/qemu-esp32/triage/`), so
  upstream merges stay mechanical.
- **Update cadence:** VS Code every 2–3 months; KiCad and FreeCAD on stable
  releases; Espressif QEMU at a pinned commit (its `esp-develop` branch is
  force-pushed), merged on a schedule. An update is its own WP. Re-run the REA breakdown (§9) first to
  see what changed (new protos, GAL methods, process entry points, exports).

## 7. Testing strategy

| Layer | How |
|---|---|
| Rust and TypeScript units | `cargo test`, Vitest |
| KiCad engine | round-trip and render goldens on the `kicad-demos` corpus (36 projects); Stream GAL display-list goldens; ERC/DRC parity with `kicad-cli` |
| CAD engine | recompute goldens for FreeCAD test documents; tessellation checksums |
| App | Playwright on the Electron app, on Windows and Linux: open project, edit, run sim |
| Simulation | deterministic scenario replays; per-part scenarios; per-scope runs (whole device, circuit, code, mechanism); scheduler property tests |
| Boards | per-board scenario suites (Uno, Nano, Mega, ESP32, ESP32-S3, Pico, Raspberry Pi bridge) on every emulator or peripheral-model change |
| Performance | benchmarks for PLAN §4.14, tracked in CI |

## 8. Build and CI

- Toolchains: Node (VS Code's pinned version), pnpm, Rust stable, CMake + Ninja,
  and the C/C++ compilers per OS (GCC on Linux, **MSVC** on Windows). Dependencies
  install via `scripts/dev/setup.sh` (Linux) and `scripts/dev/setup.ps1` (Windows).
- CI: GitHub Actions matrix with **Windows and Linux from the first commit** (macOS
  by P8), with **ccache**, cargo and pnpm caches. Windows engine builds use vcpkg
  (KiCad), LibPack or conda/pixi (FreeCAD) and MSYS2 (QEMU). Native engine builds
  are cached by upstream version and patch hash.
- **Windows rules:** no Linux-only scripts or paths in product code; keep platform
  code (paths, pipes, process spawning, file locking) behind small interfaces;
  long-path-safe file handling; test engine restarts with files open.
- Nightly builds (Windows installer and portable zip, Linux) are uploaded as
  artifacts, so the owner can try them.

## 9. Using REA (reverse engineering)

Use the **`rea-full-breakdown`** skill (`.claude/skills/`). It runs REA in
**unbounded mode** from the owner's fork (`NoboIshraque/rea`, branch
`claude/unified-engineering-platform-jn5rmk`). Use it when:
- **Updating a fork:** compare the new shipped build with the old one. For VS Code
  bundles, `compare-application-versions`. For KiCad, symbol diffs via the `-dbg`
  package. For FreeCAD, export diffs.
- **Integrating behavior that isn't documented**, from a shipped binary.
- **Learning from other tools** (simulators, EDA, CAD).

For source trees we have (the forks), read the source. REA is for shipped artifacts.

## 10. Lessons from the planning sessions

- **Cloud sessions can restart** and kill running processes. Two restarts
  happened while analysis jobs together used about 10 GB of RAM. So keep
  combined memory of background jobs under about 6–8 GB, launch long jobs
  detached (`setsid nohup … &`) with logs on disk, and **commit and push often**.
- **Running downloaded third-party binaries can be blocked** by the session's
  safety policy (a headless Blender run was refused). Build engines from source
  inside sessions, and ask the owner before any workaround. Never bypass a refusal.
- Large native builds (KiCad, FreeCAD, VS Code) take long. Use ccache, build only
  needed targets, and prefer CI for full builds.
- **Claude's sessions run Linux only.** Windows is checked by CI and by the owner's
  nightly tests, so push early enough for the Windows jobs to report before a
  session ends.
- **REA's limits are gone, but memory isn't.** The 21 MB VS Code workbench bundle
  parsed fully in 30 minutes, but its semantic graph needed more than the 6 GiB
  worker heap. For open-source trees, read the source instead.
- **Cloud sessions set `NODE_OPTIONS=--use-openssl-ca --max-old-space-size=8192`.**
  V8 uses the last heap flag it sees, so a script that sets its own heap size must
  append the flag to `NODE_OPTIONS`, not put it first. Putting it first silently
  overrode REA's parent heap in the planning runs. Check this before sizing Node
  builds (VS Code's build in P0-2) or analyses.

**From the first build session (P0, 2026-11-24):**
- **GitHub's 2-core runners have 8 GB of memory and about 14 GB of free
  disk.** VS Code's bundler needed more than 7 GB; the app bundles one entry
  point at a time without source maps (3.7 GB, DV-13). An 8 GB swap file then
  filled the Linux disk during `pnpm install`, and the runner died without a
  log: don't trade disk for memory there. A full `tsc` typecheck of VS Code ran
  out of a 7 GB heap; type-check Triage's code with `src/tsconfig.triage.json`.
- **Measure before guessing.** A watchdog that samples the process tree's RSS
  (`/proc`) and kills it at a limit found the bundler's peak in two minutes,
  safely inside a cloud session.
- **Windows images differ:** `windows-2025` offers Visual Studio 2026, where VS
  Code's native modules failed (Spectre libraries, inferred); the app builds on
  `windows-2022` (DV-12). Windows runners also carry Strawberry Perl's `ccache`.
- **App builds take about 25 minutes per OS in CI**, so the App workflow queues
  instead of cancelling. It skips documentation-only pushes.
- **New files must be formatted before their first commit:** the native
  formatter lists files with `git ls-files`, so it now includes untracked ones.
- **The Welcome page takes focus about 300 ms after it opens**, which closes
  a command palette opened in between. Smoke tests wait for its step to have
  focus, and `runCommand` retries opening the palette, as upstream's
  `openQuickAccessWithRetry` does.
- **Claude's sessions may build and run the app** (the owner OK'd Electron on
  2026-11-24): `node app/build.mjs package && node app/build.mjs engines`, then
  `xvfb-run -a pnpm --filter @triage/app-smoke smoke` on Linux. CI stays the
  check of record on both systems.

## 11. When Claude stops and asks

- A decision changes product scope, user-visible behavior or architecture (ADR level).
- Anything outward-facing: publishing a release, creating repositories, posting
  anywhere.
- Two consecutive sessions fail to reach a WP's "done when". Re-plan with the owner.
