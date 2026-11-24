# CLAUDE.md: building Triad

Triad (working name) is a **standalone desktop app built from VS Code's source**
that unifies firmware coding, electronics (KiCad's engine), parametric 3D design
(FreeCAD's engine, Blender-style UX), rendering (Blender) and **whole-device
simulation**. The team is two: **the owner and Claude**.

**Status: planning complete; build starts at ROADMAP P0-1.**

## Read first, every session

1. `docs/STATUS.md`: current work package, open questions, session log.
2. `docs/ROADMAP.md`: the work package you're on (goal, deliverable, done-when).
3. `docs/GUIDELINES.md`: session routine, definition of done, forks, testing.
4. `docs/PLAN.md` and `docs/adr/` for the sections your WP touches.
5. `docs/research/` when integrating an engine (sizes, boundaries, APIs, evidence).

## Rules

- **Architecture:** Triad forks VS Code (ADR 0001). KiCad, FreeCAD and Blender run as
  headless **engine processes** behind Triad's UI (ADR 0002: Stream GAL, remote tools,
  CAD RPC). Don't reimplement an engine algorithm that the engine already has.
- **Files are the source of truth:** KiCad files (electronics) and FreeCAD files
  (mechanical) must stay openable in stock KiCad and FreeCAD. Keep golden tests green.
- **Forks:** upstream stays untouched; changes go in `patches/`; Triad code lives
  in its own folders (GUIDELINES §6).
- **Work in WP order**, one WP at a time unless the owner runs parallel sessions.
  Ask before ADR-level decisions (GUIDELINES §11).
- **Commit and push often:** cloud sessions can restart. Keep background jobs
  under ~6–8 GB RAM combined and launch long jobs detached.
- **Never execute downloaded third-party binaries without the owner's OK**, and
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
  forked engines (follow upstream style there).
- Conventional Commits. Develop on the branch assigned to the session.
- Every WP meets the definition of done (GUIDELINES §4) and updates `docs/STATUS.md`.
