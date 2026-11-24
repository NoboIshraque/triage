---
name: rea-full-breakdown
description: Complete, unbounded reverse-engineering breakdowns with REA in unbounded mode (no time limits, no fixed size caps). Use whenever an app, binary, package, library or engine must be broken down in full (architecture, processes, subsystems, APIs, IPC, plugin boundaries, file formats, sizes) to rebuild it, reuse it or integrate it. Supersedes reverse-engineer-anything for full teardowns.
metadata:
  version: "1"
  base_skill: reverse-engineer-anything v44 (REA 6.7.0)
---

# REA full breakdown (unbounded)

This skill runs REA with its **unbounded mode**: analysis deadlines and fixed
byte, entry and record budgets are lifted, so a breakdown runs until the whole
target is done. The bounded upstream skill stops at defaults (for example 300 s
per JavaScript source and a 64 MiB .NET metadata budget). Don't settle for that
here.

## 1. Get the unbounded REA build

Unbounded mode lives in the owner's REA fork: `NoboIshraque/rea`, branch
`claude/unified-engineering-platform-jn5rmk` (commit `6697bfd` or later). See
its `docs/unbounded-mode.md`. The npm package does **not** contain it.

```bash
cd ../rea   # sibling checkout; add it to the session if missing
git checkout claude/unified-engineering-platform-jn5rmk
HUSKY=0 npm ci && npm run build:cached
REA=/abs/path/to/rea/scripts/rea-unbounded.sh   # sets REA_UNBOUNDED=1 + a large Node heap
$REA --version
```

- **CLI (preferred for big targets):** `$REA <command> … --json`. Every
  invocation is a fresh process, so it always runs the current build.
- **MCP tools:** `claude mcp add --scope local rea -- /abs/path/to/rea/scripts/rea-unbounded.sh mcp`,
  then restart the agent. Set `REA_MCP_MAX_RESPONSE_BYTES` high, and still
  prefer `--detail summary` plus an Evidence bundle file for large results.
- Never run the plain `rea`/`npx rea-agents` for full breakdowns. Their bounded
  defaults will stop early.

## 2. Rules of a full breakdown

1. **Whole target, not a sample.** Analyze complete directories and binaries.
   Use `--source-path` only to *split work across parallel processes*, never to
   skip parts.
2. **No timers.** Leave deadline options unset (unbounded defaults ≈ 24.8 days).
   Run long analyses **in the background**, watch the `rea_progress` lines on
   stderr, and never kill a run because it is slow.
3. **Keep output on disk.** Use `--detail summary --evidence_output <bundle>`
   (or `--evidence-bundle` for managed members), then read with
   `inspect-analysis-view` / `inspect-evidence-bundle`. The bundle file is a
   bundle: extract the producing record (`records[]` where `operation` matches)
   before pointing an `evidence-file` view at it.
4. **Parallelize by memory.** REA processes the sources of one run one after
   another. Split independent subtrees (for example `out/` vs `extensions/`)
   into separate runs. Give each run an explicit `--max-heap-mb` and
   `REA_PARENT_HEAP_MB` so their sum fits host RAM.
5. **When something still fails, keep going.** An out-of-memory or engine
   limit (V8 string length, disk) is not the end: reuse the returned
   `partial_observation`, split the input further, raise heap, or move to a
   bigger machine. Record what is blocked and continue with the rest.
6. **Use the best evidence available.** Prefer packages that ship **debug
   symbols** (`*-dbg`, `*-dbgsym`, `.debug` files, PDBs) for native targets.
   Read readable shipped source (JS, Python, `.repl`/config) directly. Add
   **runtime probes** (process capture, headless runs that dump APIs) when
   static evidence cannot answer the question.
7. **Licenses are out of scope** for breakdown work unless the user asks
   (owner's decision, 2026-11-23).
8. **Evidence discipline stays.** Tag every claim observed / inferred /
   unknown, cite Evidence IDs and artifact SHA-256, and keep a ledger.

## 3. The full-breakdown procedure

For each target app:

1. **Acquire** the shipped build for the analysis platform, plus debug-symbol
   packages and SDK/headers if they exist. Put each in its own directory.
2. **Inventory:** `inspect-desktop-application <dir>` (unbounded inventories
   every entry). List runtimes, bundled engines and plugins.
3. **Deep analysis per runtime:**
   - JavaScript/Electron: `analyze-javascript-application <dir>` over the
     whole app, split across parallel runs. Add `inspect-electron-fuses` and
     preload/IPC facts through `javascript-facts` views.
   - Native: `inspect-native-exports`, `inspect-elf-notes`,
     `inspect-with-objdump <file> symbols|dwarf|section_headers` (unbounded
     output), dynamic dependencies with `readelf -d`. Use a decompiler provider
     (Ghidra/Rizin/Kuna) for function bodies when needed.
   - .NET: `inspect-managed-artifact`, then `inspect-managed-members` (complete).
4. **Subsystem map with sizes:** group symbols, source paths or modules by
   subsystem, and count functions and bytes per subsystem. Sizes turn a
   teardown into build or reuse estimates.
5. **Interfaces:** IPC protocols, plugin entry points, public APIs, file
   formats, CLIs, extension manifests.
6. **Runtime probes** where needed (for example a headless run that dumps an
   API inventory). Record command lines and outputs as evidence.
7. **Write the report and ledger:** findings per question, Evidence IDs,
   coverage, what remains unknown, and how to reproduce.

Before finishing, revisit the question checklist. A breakdown is complete only
when every planned target ran to completion or has a recorded, concrete blocker.

## 4. References

- Recipes that worked on large real targets (VS Code, KiCad, Blender, Renode):
  [references/unbounded-recipes.md](references/unbounded-recipes.md)
- Tool usage from the base skill (still valid; replace `npx rea-agents@6.7.0`
  with `$REA`):
  - [references/javascript-applications.md](references/javascript-applications.md)
  - [references/native-and-artifacts.md](references/native-and-artifacts.md)
  - [references/runtime-observation.md](references/runtime-observation.md)
  - [references/evidence-workflows.md](references/evidence-workflows.md)
  - [references/android-applications.md](references/android-applications.md)
  - [references/connection-and-recovery.md](references/connection-and-recovery.md)
