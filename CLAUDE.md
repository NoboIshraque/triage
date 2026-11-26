# CLAUDE.md: building Triage

Triage is a **standalone desktop app built from VS Code's source** that unifies
firmware coding, electronics (KiCad's engine), parametric 3D design (FreeCAD's
engine, Blender-style UX), rendering (Blender) and **whole-device simulation**, all
in **one window**. Boards: **ESP32, Arduino, Raspberry Pi**. Platform: **Windows
first** (the owner's laptop), Linux too, macOS later. The team is two: **the owner
and Claude**.

**Status: building. `docs/STATUS.md` names the current work package.**

## Read first, every session

1. `docs/STATUS.md`: current phase and work package, open questions, session log.
   `docs/CHECKS.md`: the owner's checks. Act on any the owner marked done or
   wrote results into, and record those results in `docs/STATUS.md`.
2. `docs/ROADMAP.md`: the work package you're on (goal, deliverable, done-when).
3. `docs/GUIDELINES.md`: session routine, definition of done, forks, testing.
   `docs/DEVIATIONS.md`: where the build already differs from the plan.
4. `docs/PLAN.md` and `docs/adr/` for the sections your WP touches.
5. `docs/research/` when integrating an engine (sizes, boundaries, APIs, evidence).

## Rules

- **Architecture:** Triage forks VS Code (ADR 0001). KiCad, FreeCAD and Blender run as
  hidden **engine processes** behind Triage's own tabs (ADR 0002, accepted: Stream
  GAL, headless tools, CAD RPC). Don't reimplement an engine algorithm that the
  engine already has.
- **One window:** everything the user does happens in Triage's tabs (any tab can
  also be popped out into a separate Triage window, DV-14). The stock
  KiCad or FreeCAD window is only a temporary fallback where the ROADMAP lists it.
  Simulation must work for the whole device and for any part alone (PLAN §4.7).
- **Windows is first-class:** CI stays green on Windows and Linux. No Linux-only
  scripts, paths or assumptions in product code (GUIDELINES §8). Boards and
  emulators: ADR 0003.
- **Files are the source of truth:** KiCad files (electronics) and FreeCAD files
  (mechanical) must stay openable in stock KiCad and FreeCAD. Keep golden tests green.
- **Forks:** upstream stays untouched; changes go in `patches/`; Triage code lives
  in its own folders (GUIDELINES §6).
- **Work in WP order**, one WP at a time unless the owner runs parallel sessions.
  Ask before ADR-level decisions (GUIDELINES §11).
- **One phase per session.** The owner starts every phase (P0, P1, …) in a new
  session. Finish the whole phase, update `docs/STATUS.md`, push, then tell the
  owner the phase is done so they can start the next one (GUIDELINES §2).
- **Owner checks live in `docs/CHECKS.md`.** Whenever work needs something only
  the owner can do (a run on the Windows laptop, an exit demo, a measurement on a
  real GPU, a setting on GitHub), add a check there **in the same commit**, with
  clear, detailed, numbered steps: where to get the build, the exact clicks,
  keys and commands, what the owner should see, and what to tell Claude. Keep
  every open check current when the build, a command, a file or the build branch
  changes, and keep the "At a glance" table and the "Current build branch" line
  up to date. **Never mark a check done; only the owner does.** Tell the owner
  at the end of a session which checks were added or changed.
- **Log every deviation from the plan** in `docs/DEVIATIONS.md`, in the same
  commit as the change: what the plan said, what was built, why. The owner
  compares the final build with the plan from that list.
- **Commit and push often:** cloud sessions can restart. Keep background jobs
  under ~6–8 GB RAM combined and launch long jobs detached.
- **Never execute downloaded third-party binaries without the owner's OK** (the owner
  OK'd Electron, which VS Code's build downloads, on 2026-11-24), and
  never bypass a refused action. Build from source instead.
- **Evidence discipline** for claims about other tools: observed / inferred /
  unknown, with sources or REA Evidence IDs.
- Licenses are out of scope (owner's decision). The combined app is GPL-3.0-or-later.

## REA (reverse engineering)

Use the vendored **`rea-full-breakdown`** skill (`.claude/skills/rea-full-breakdown/`).
It needs the unbounded REA build:

```bash
cd ../rea && git checkout claude/unified-engineering-platform-jn5rmk \
  && HUSKY=0 npm ci && npm run build:cached
REA=/abs/path/to/rea/scripts/rea-unbounded.sh   # CLI: $REA <command> … --json
# MCP (local scope, not committed): claude mcp add --scope local rea -- $REA mcp
```

Reproduce the research: `REA=$REA scripts/research/teardown.sh /abs/workdir`.

## Conventions

- TypeScript (strict) in the app; Rust for model, kernel and solvers; C++ in the
  forked engines and C in the QEMU peripheral models (follow upstream style there).
- Conventional Commits. Develop on the branch assigned to the session.
- Every WP meets the definition of done (GUIDELINES §4) and updates `docs/STATUS.md`.
