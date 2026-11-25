# ADR 0004: Host KiCad's editing algorithms directly; Triage owns the interactive tools

- **Status:** **Proposed**, 2026-11-25, from the P1-6 spike. The owner decides
  (GUIDELINES §11). Until then, P1's simple edits stand as they are and nothing
  in P5 or P6 starts on either path.
- **Related:** [ADR 0002](0002-absorb-engines-headless.md) (hidden engines,
  Stream GAL), PLAN §4.3 (stage 2: full in-app editing) and D10, ROADMAP P1-6,
  P5-1, P6, research [kicad.md](../research/kicad.md)

## In plain words

When you route a track or move a part in Triage's Board tab, **KiCad's own code
does the routing and the editing.** The push-and-shove router, connectivity, the
rules checks and the file writing are all KiCad's. **Triage draws the tool**: the
rubber-band track under your cursor, the snapping, the keyboard shortcuts, the
little panels. This decision is about how those two halves talk to each other.

The spike tried the two ways the plan listed. Running KiCad's tools unchanged
would need a hidden KiCad editor window inside the engine. Hosting KiCad's
algorithms directly works today without any window, and the router answers a
cursor move in under 1 ms.

## Context

PLAN §4.3 left two paths open for stage 2 (full in-app editing, P5 and P6):

1. **Remote tools:** run KiCad's interactive tool framework (`TOOL_MANAGER`,
   `ROUTER_TOOL`, `EDIT_TOOL`, `DRAWING_TOOL`, eeschema's `SCH_*_TOOL`s) on the
   engine's main loop, and turn canvas events from Triage into KiCad
   `TOOL_EVENT`s.
2. **Direct hosting:** the engine hosts the algorithm layers below the tools
   (for example `PNS::ROUTER` through `PNS_KICAD_IFACE_BASE`), and Triage feeds
   them cursor positions and commands over the engine API.

### What the spike found

| Finding | Basis |
|---|---|
| **KiCad's router runs headless in the engine.** `pcb/pcb_route.cpp` hosts `PNS::ROUTER` on a `PNS_KICAD_IFACE_BASE` subclass, the way KiCad's own QA log player does (`qa/tools/pns/pns_log_player.h`, `PNS_LOG_PLAYER_KICAD_IFACE`). It has no frame, no `TOOL_MANAGER` and no wx window. | [O] engine source; `Route` request |
| **The router is fast enough for live dragging.** 40 cursor moves from R2 pad 1 to A1 pad 24 on the Smart Fan board in shove mode averaged **0.15–0.18 ms per `Move()`**, worst **0.66–0.72 ms**, against a 16 ms frame budget. The route committed 4 track segments through the engine's own undo stack. | [O] `app/engine-tests/src/edaEngine.test.ts`, `build/benchmarks/eda-route-linux.json` (two runs) |
| **KiCad's commit and connectivity code also runs without a frame.** Schematic edits use `SCH_COMMIT` with a `TOOL_MANAGER` that has no view or frame, as `EESCHEMA_HELPERS::LoadSchematic` (kicad-cli's loader) does. Board edits run `BuildConnectivity` and the ratsnest the same way. Files saved this way open in kicad-cli (DRC, ERC) and keep their netlists. | [O] `sch/sch_edit.cpp`, `pcb/pcb_edit.cpp`; engine tests; smoke test |
| **KiCad's tools are built on a frame.** Each tool reaches its editor through `TOOL_BASE::getEditFrame<T>()`, a cast of the tool holder (`include/tool/tool_base.h`). The editor frames derive `EDA_DRAW_FRAME → KIWAY_PLAYER → wxFrame`. Counted uses: `router_tool.cpp` has 46 `frame()` and 24 `m_frame`, `edit_tool.cpp` 46 `frame()`, `drawing_tool.cpp` 46 `frame()` and 238 `m_frame`. In eeschema, `sch_move_tool.cpp` has 66 `m_frame`, `sch_line_wire_bus_tool.cpp` 55, `sch_drawing_tools.cpp` 200, `sch_edit_tool.cpp` 171. | [O] KiCad 10.0.8 source (grep counts) |
| **The tools also need view controls and dialogs.** `getViewControls()` is used 25 times in `router_tool.cpp` and 28 in `drawing_tool.cpp` (cursor, snapping, auto-pan). The three pcbnew tools have 14 lines that name a `DIALOG_*` class (3, 6 and 5). | [O] same source |
| **The engine has no window to give them.** It is a `wxAppConsole` like kicad-cli, with no GUI toolkit. That lets it run without a display in CI and on servers. A `wxFrame` needs a GUI `wxApp`, which on Linux means GTK and a display. | [O] `engine/main.cpp`; [I] wxWidgets requirements |

### What remote tools would cost

[I] To run the tools unchanged, the engine would have to become a GUI wx app with
a hidden `PCB_EDIT_FRAME` and `SCH_EDIT_FRAME`, or stubs of them. It would need a
fake `VIEW_CONTROLS` that takes Triage's cursor, and a wrapper for every dialog
those tools open. That brings back the stock window machinery that ADR 0002 keeps
out of sight. It needs a display on Linux, including CI. And it ties Triage to the
frame's private behaviour, which KiCad changes between releases. The tools' event
loops (`Wait()` coroutines) would also run one tool at a time per frame, while
Triage wants each tab to be independent.

## Decision (proposed)

1. **Direct hosting is the editing path.** The engine hosts KiCad's algorithm
   layers through the engine faces:
   - the router (`PNS::ROUTER`: single tracks, differential pairs, length tuning,
     dragging), plus the zone filler (`ZONE_FILLER`) and `DRC_ENGINE`;
   - the board's connectivity and ratsnest, and the schematic's connectivity and
     annotation;
   - the commit, undo and save code, plus the footprint and symbol libraries
     through KiCad's library adapters.
2. **Triage owns the interactive tools.** Each tool is a small state machine in
   the Triage view (TypeScript): select, move, wire, place, route, zone, measure.
   It sends **sessions** to the engine: begin, update with the cursor, commit,
   cancel. The engine answers each update with temporary display-list groups for
   the preview. Snapping, grids, keys and panels are Triage's.
3. **No new algorithms in Triage.** A tool that needs geometry or electrical
   logic calls KiCad's code for it. For example, a drag uses `PNS::DRAG`, not a
   Triage drag (CLAUDE.md: don't reimplement an engine algorithm).
4. **Where a KiCad tool's behaviour is not behind a clean algorithm API**, the
   engine face copies the tool's sequence of algorithm calls, as `pcb_route.cpp`
   copies `ROUTER_TOOL`'s `FixRoute` and `CommitRouting`. The copied sequence is
   noted in that face's source, with the upstream file and line, so a KiCad update
   can be checked against it. If one tool turns out to cost more this way than a
   frame stub would, it gets its own ADR. Remote tools stay rejected unless that
   happens.

## Consequences

Good:
- Editing stays headless: the engine needs no display and runs the same way in
  CI, on Windows and on Linux. The stock KiCad window stays a temporary fallback
  only (P1-7).
- Interaction is fast: sub-millisecond router steps leave the frame budget to
  the renderer and the IPC.
- Each tab has its own tool, and several tools can run in several tabs at once.
- KiCad's frames, dialogs and wx event loop never enter the engine.

Costs:
- Triage writes the tool front ends: about 10 tools for P5 and P6 (select, move,
  wire and bus, symbol and footprint place, track route, diff pair, tune, zone,
  via, measure). Each has its own preview and settings panel.
- Engine faces copy some sequences from KiCad's tools. On a KiCad update, those
  notes are the checklist (GUIDELINES §6).
- The P1 `Route` request takes all its moves in one call. P6 turns it into a
  session (`RouteBegin`, `RouteMove`, `RouteFix`, `RouteCancel`) with preview
  display lists.

Unknown [?]: how much of `EDIT_TOOL`'s and `SCH_MOVE_TOOL`'s behaviour (dragging
connected wires and tracks, keeping pins attached) sits in the tools rather than
in the algorithm layers. P5-1 and P6 measure it per tool, before they build.
