# Teardown: KiCad 10

**Targets:** KiCad 10.0.8 for Ubuntu 24.04 x64 from the official PPA
(`kicad_10.0.8~ubuntu24.04.1_amd64.deb`), its **debug-symbols package**
(`kicad-dbg`, 1.04 GB), and `kicad-demos` (36 real projects, 341 MB) as a test corpus.

**Method:** REA in **unbounded mode** (`rea-full-breakdown` skill): native exports,
ELF notes (build-id to debug-file mapping), complete `objdump` symbol tables
(the pcbnew table alone is 25.7 MB, beyond the old 16 MiB output cap), plus
`addr2line` over the DWARF line tables to place each of ~158,000 functions in
its source file. Evidence IDs are in [evidence-ledger.md](evidence-ledger.md).

Legend: **[O]** observed in the shipped files · **[I]** inferred · **[D]** documentation · **[?]** unknown.

## 1. Packaging: a launcher plus loadable "kifaces"

| Fact | Basis |
|---|---|
| `bin/` holds **seven `.kiface` shared objects** (`_eeschema` 25 MB, `_pcbnew` 41 MB, `_cvpcb`, `_gerbview`, `_pl_editor`, `_pcb_calculator`, `_kipython`) | [O] |
| **Every kiface exports a single entry symbol, `KIFACE_1`** | [O] exports |
| `eeschema`, `pcbnew`, `gerbview`, `pcb_calculator` and `pl_editor` are **identical 88 KB stubs** that load their kiface | [O] sizes / [I] |
| `kicad` (5 MB) is the project manager. It hosts all kifaces in one process (KIWAY) | [I] + [D] |
| Shared libraries: `libkicommon` (common code, settings, API server, jobs, git), `libkigal` (graphics), `libkiapi` (protobuf API types), `libkicad_3dsg` (3D scene graph) | [O] |
| **`_pcbnew.so` (the Python module) is a symlink to `_pcbnew.kiface`**, which exports both `KIFACE_1` and `PyInit__pcbnew` | [O] |
| Built with **link-time optimization** (compile units are `<artificial>`) | [O] DWARF |

## 2. Size map: where KiCad's code is (full debug-symbol breakdown)

All KiCad binaries total **~158,000 functions and ~81 MB of machine code**.
Every function was placed in its source file (unmapped: under 0.5% per binary) [O].

| Binary | Functions | Code | Source files |
|---|---|---|---|
| `_pcbnew.kiface` (PCB editor) | 54,428 | 29.5 MB | 2,093 |
| `_eeschema.kiface` (schematic + simulator) | 32,351 | 19.7 MB | 1,456 |
| `_cvpcb.kiface` (footprint assignment) | 21,020 | 10.7 MB | 953 |
| `libkicommon` | 11,292 | 5.6 MB | 627 |
| `kicad` (project manager) | 6,367 | 3.5 MB | 427 |
| `_gerbview` / `_pl_editor` / `_pcb_calculator` | 6,275 / 5,929 / 3,831 | 3.2 / 2.9 / 2.7 MB | – |
| `libkiapi` (protobuf API) | 7,007 | 0.9 MB | 47 |
| `libkigal` (graphics) | 2,208 | 1.1 MB | 160 |
| `kicad-cli` | 888 | 0.5 MB | 143 |

**Engine vs UI** (classified by source path) [O + I]:

| | Engine | UI (dialogs, widgets, frames) | Interactive tools | C++ std templates | Python bindings (SWIG) | Bundled libs | 3D viewer |
|---|---|---|---|---|---|---|---|
| pcbnew | **42%** (12.4 MB) | 21% (6.3 MB) | 5% (1.6 MB) | 13% | 9% (2.8 MB) | 6% | 3% |
| eeschema | **49%** (9.7 MB) | 24% (4.7 MB) | 6% (1.2 MB) | 14% | – | 7% | – |

**Largest PCB subsystems** [O]: `dialogs` 3.25 MB (248 files) · `pcb_io` 3.19 MB
(101 files) · core model `pcbnew/*.cpp` 3.08 MB · `tools` 1.56 MB · `drc` 1.28 MB
(113 files) · `router` 0.94 MB (76 files) · `exporters` 0.61 MB · `connectivity` 0.18 MB.

Key files (code size) [O]:
- **Board model:** `footprint.cpp` 191 KB, `board.cpp` 144 KB, `pad.cpp` 119 KB, **`zone_filler.cpp` 104 KB**, `pcb_track.cpp` 94 KB, `zone.cpp` 67 KB, `pcb_painter.cpp` 62 KB.
- **Router (PNS):** `pns_shove.cpp` 105 KB, `pns_line_placer.cpp` 87 KB, `pns_topology.cpp` 60 KB, `pns_node.cpp` 47 KB, diff-pair/meander/dragger/optimizer.
  **`pns_kicad_iface.cpp` (81 KB) is the single adapter between the router and KiCad's board and view.** The interactive `router_tool.cpp` (124 KB) sits on top.
- **DRC:** `drc_engine.cpp` 129 KB, test providers (copper clearance, library parity, creepage), rule parser. The graphical rule editor (new in 10) is UI.
- **Importers/exporters (`pcb_io`):** Altium 254 KB, Allegro 249 KB, CADSTAR 246+210 KB, **IPC-2581** 201 KB, PADS 187 KB, KiCad S-expression parser 152 KB, Eagle 116 KB, Fabmaster 102 KB.
- **Schematic:** `connection_graph.cpp` 185 KB (netlist connectivity), `sch_symbol.cpp`, `lib_symbol.cpp`, `schematic.cpp`; `sim/` 1.5 MB (ngspice models, IBIS/KIBIS parser, simulator UI).

### The graphics boundary (GAL) is small

`libkigal` is only 1.1 MB. The abstract **`KIGFX::GAL` has 68 methods**; the Cairo
backend overrides ~45 [O, demangled symbols]:

```
frame:      BeginDrawing EndDrawing Flush ClearScreen ResizeScreen
primitives: DrawLine DrawSegment DrawSegmentChain DrawPolyline DrawPolylines DrawPolygon
            DrawCircle DrawArc DrawArcSegment DrawRectangle DrawCurve DrawBitmap
            DrawGlyph DrawGlyphs BitmapText DrawGrid DrawCursor DrawHoleWall
state:      SetFillColor SetStrokeColor SetLineWidth SetIsFill SetIsStroke
            SetLayerDepth SetTarget SetNegativeDrawMode
transforms: Translate Rotate Scale Save Restore Transform
groups:     BeginGroup EndGroup DrawGroup DeleteGroup ChangeGroupColor ChangeGroupDepth ClearCache
layers:     StartDiffLayer EndDiffLayer StartNegativesLayer EndNegativesLayer
```

`KIGFX::VIEW` (46 methods) owns items, layers and cached groups and calls the
painters (`PCB_PAINTER`, `SCH_PAINTER`), which emit GAL calls.

**Consequence:** a new GAL backend that **records these calls into display lists
and streams them to Triage's GPU canvas** reproduces KiCad's rendering exactly.
It is a bounded job of about 45 methods. KiCad's own painters, VIEW caching and
layers keep working unchanged.

## 3. The IPC API (protobuf over nng)

| Fact | Basis |
|---|---|
| `libkiapi.so` exports 6,486 symbols, including protobuf descriptor tables for **15 `.proto` files** | [O] |
| `libkicommon` links **`libnng.so.1`** and `libprotobuf.so.32` and contains `KICAD_API_SERVER` (`common/api/api_server.cpp`, 17 KB), `api_plugin_manager.cpp` (75 KB), `KINNG_REQUEST_SERVER` and the socket template `ipc://{}` | [O] |
| Requests are handed to the wx UI thread (`handleApiEvent(wxCommandEvent&)`), so **API calls serialize on the UI thread** | [I] symbol names |
| KiCad 9/10 IPC talks only to a running GUI. Headless `kicad-cli api-server` is post-v10 (KiCad 11, ~Feb 2027) | [D] |

```
board/board.proto  board/board_commands.proto  board/board_types.proto
common/envelope.proto  common/commands/{base,editor,project,variant}_commands.proto
common/types/{base_types,embedded_files,enums,project_settings,variants}.proto
schematic/schematic_commands.proto  schematic/schematic_types.proto
```

Plugin surfaces: `api.v1.schema.json` (IPC plugins: `python`/`exec` runtime, toolbar
actions with scopes), **`kicad-remote-provider-metadata-v1.schema.json`** (remote
parts provider: OAuth2, `parts_v1`, `web_ui_v1`), and PCM v1/v2 [O].

## 4. Engines KiCad embeds

| Engine | Coupling | Basis |
|---|---|---|
| **ngspice** | **dlopen'd at runtime**: strings `libngspice.so.0`, search-path messages, `ngSpice_Init/Circ/Command/AllPlots/AllVecs/CurPlot/running/LockRealloc`, XSPICE code models | [O] strings, no NEEDED / [I] |
| **OCCT** | pcbnew links TKSTEP, TKXDESTEP, TKIGES, TKSTL, TKBRep, TKMesh, TKXCAF, TKBO... | [O] NEEDED |
| GAL | OpenGL (GLAD, GLU) + Cairo fallback | [O] |
| git | libgit2 (built-in version control) | [O] |
| others | ODBC (database libraries), libspnav (3D mouse), Python 3.12, wx webview, tinyspline, zint, nlohmann_json, pegtl, fmt, clipper2, rtree, pybind11 | [O] |

## 5. `kicad-cli`: headless automation

`pcb export` gerbers, drill, pos, svg, dxf, hpgl, gencad, **ipc2581**, **odb**, ipcd356,
**step**, stpz, **glb**, vrml, stl, ply, xao, brep, u3d, 3dpdf · `pcb drc` · **`pcb render`** ·
`sch erc` · `sch export` (netlist, BOM, PDF, SVG) · `sym`/`fp` upgrade · **`jobset run`** [O strings].

## 6. File formats

`.kicad_pro` (JSON) and the S-expression `.kicad_sch`, `.kicad_pcb`, `.kicad_sym` and
`.kicad_mod` are text, documented, and diff-friendly. They are Triage's electronics
source of truth. KiCad's own parser (`pcb_io_kicad_sexpr_parser.cpp`, 152 KB) is
part of the engine we reuse.

## 7. What Triage takes from KiCad (standalone app)

1. **Absorb KiCad's engine, replace its UI.** Build a headless **EDA engine
   process** from KiCad's source (board and schematic models, connectivity,
   router, DRC, zone filler, importers and exporters, plotters, simulator glue,
   kicad-cli jobs). That is roughly 45–50% of pcbnew and eeschema code that we
   don't rewrite. The wx dialogs and frames (~21–26%) are what Triage
   reimplements in its own UI.
2. **Stream GAL:** add a GAL backend that serializes draw calls to Triage's
   canvas. Rendering is pixel-identical to KiCad with ~45 methods of work.
3. **Remote tools:** feed Triage canvas input into KiCad's tool framework
   (`common/tool`), so KiCad's interactive tools (selection, edit, drawing,
   **router**) run headlessly against our canvas. Replace their dialogs one by one.
4. **API:** extend KiCad's protobuf API (same envelope, more commands) as the
   control channel between Triage's UI and the EDA engine. Mind the UI-thread
   serialization: batch requests.
5. **Keep KiCad files**, so a project still opens in stock KiCad.

## 8. Unknowns and limits

- [?] How much of the tool framework depends on wx event types and frames.
  Prototype it early: ROADMAP P1-6 spikes remote tools against hosting the
  router directly through `pns_kicad_iface.cpp` (ADR 0004).
- [?] Runtime behavior. Executing downloaded binaries was blocked by the
  session's safety policy, so all findings are static.
- The UI-thread serialization is inferred from symbol names.
- The engine/UI split is a path-based classification, not a dependency analysis.
