# CLAUDE.md: working on Triad

Triad (working name) is a suite of **VS Code extensions** that unifies firmware
coding, electronics (KiCad schematic + PCB), 3D mechanical design (parametric
CAD, Blender-style UX) and **whole-device simulation**, inside the VS Code
students already use.

**Status: planning.** No application code exists yet.

## Read first

1. `docs/PLAN.md`: architecture, the unified project model, the simulation
   kernel, tech stack, licensing rules, and the decisions table (§5).
2. `docs/ROADMAP.md`: phases with exit demos. Work in phase order. Start
   with "Phase 0, sprint 1" unless the user directs otherwise.
3. `docs/research/`: teardown findings for VS Code, KiCad, Blender and the
   simulators, with REA Evidence IDs in `evidence-ledger.md`.

## Hard rules

- **Licensing (PLAN §4.12, decision D1 pending, default Option A):** never load
  GPL code (KiCad, Blender, simavr, ngspice's GPL parts, QEMU, freerouting) into
  the extension host, our webviews or the model service. Reach GPL
  programs only through documented interfaces (KiCad IPC API, CLIs, sockets,
  files). Do not copy code from GPL projects into our sources unless D1 is
  changed to GPL-3.0.
- **KiCad-native files are the electronics source of truth.** Our writers must
  round-trip the `kicad-demos` corpus losslessly.
- **Clean-room only.** Learn from proprietary tools (Wokwi, Proteus, Fusion,
  BeamNG...) through public docs and behavior. Never decompile them or copy
  their code or assets.
- **Evidence discipline** when making claims about third-party tools: separate
  observed / inferred / unknown and cite sources or Evidence IDs.
- **Host: the real VS Code** (D2, confirmed; `docs/adr/0001-run-inside-vscode.md`).
  No fork, no separate app. Use stable extension APIs only. Any proposed API, or
  any reason to fork, needs a new ADR first.

## Using REA (reverse engineering) in this repo

The skill is vendored at `.claude/skills/reverse-engineer-anything/` (v44,
pinned to `rea-agents@6.7.0`). REA is for **shipped artifacts** (binaries,
packages). For open-source source trees, read the source instead.

- MCP tools for a session (local scope, so nothing gets committed):
  `claude mcp add --scope local rea -- npx -y rea-agents@6.7.0 mcp`, then restart.
- CLI without MCP: `npx -y rea-agents@6.7.0 <command> … --json`. Or build the
  sibling repo: `cd ../rea && HUSKY=0 npm ci && npm run build:cached`, then
  `node ../rea/scripts/rea.mjs`.
- Re-run the full teardown on new upstream releases:
  `REA="node ../rea/scripts/rea.mjs" scripts/research/teardown.sh /abs/workdir`.
  Compare against `docs/research/evidence-ledger.md`.

## Conventions (to be finalized in Phase 0)

- TypeScript (strict) for UI and extensions; Rust for model, kernel and
  solvers; C++ only behind service boundaries (OCCT, ngspice, MuJoCo).
- Conventional Commits. Develop on the branch assigned to the session.
- Every phase ends with a recorded exit demo, CI green on Linux, Windows and
  macOS, performance budgets measured (PLAN §4.14), and an ADR in `docs/adr/`
  for each newly confirmed decision.
