# engines/cad/: FreeCAD engine

FreeCAD fork run headless as Triage's CAD engine: FreeCAD's App layer, no GUI
([ADR 0002](../../docs/adr/0002-absorb-engines-headless.md),
[research](../../docs/research/freecad.md)). ROADMAP **P2-1 … P2-5**.

| Path | What |
|---|---|
| `upstream.json` | the pinned FreeCAD release (1.1.4, tag and commit) |
| `upstream/` | FreeCAD's source at that commit (git-ignored; `build.mjs fetch`) |
| `patches/` | small changes to FreeCAD's files (GUIDELINES §6): `0001` finds Qt's translation tools without the GUI |
| `triage/engine/` | Triage's CAD engine host (P2-2): `triage_cad_engine.py`, which `FreeCADCmd` runs, and the `triage_cad` package (the engine connection, JSON-RPC methods, meshes); staged as `stage/triage/` |
| `tests/` | FreeCAD's own Part, Sketcher and PartDesign tests through the staged `FreeCADCmd` (`run.mjs`, `module_tests.py`), with their golden file |
| `build/<os>/` | the CMake build and `stage/` (git-ignored): FreeCAD installed into one relocatable folder (`bin/`, `lib/`, `Mod/`, `Ext/`, `data/`) |

```sh
node engines/cad/build.mjs            # fetch, prepare, configure, build, stage
node engines/cad/build.mjs test       # FreeCAD's module tests through the staged FreeCADCmd
node engines/cad/build.mjs test --update   # rewrite tests/golden/module-tests.json
```

Linux: `scripts/dev/setup.sh --cad` installs FreeCAD's build dependencies from
Ubuntu 24.04's archive (OpenCASCADE 7.6, Qt 6.4, Python 3.12). Windows:
`scripts/dev/setup.ps1 -Cad -DevShell` downloads FreeCAD's own **LibPack** (the
dependency bundle FreeCAD 1.1's CI builds with: Python 3.12, Qt 6, OpenCASCADE,
Boost …; SHA-256 checked) into `FREECAD_LIBPACK_DIR` and sets up ccache; run the
build from that developer shell. Add `--ccache` to use the compiler cache.

## What is built

FreeCAD without its GUI (`BUILD_GUI=OFF`: no Qt widgets, Coin3D or PySide) and
only the modules the engine uses (`MODULES` in `build.mjs`): Part (OpenCASCADE
shapes), Material (Part needs it), Sketcher (with its solver), PartDesign, Import
(STEP and IGES with colours), Measure, Mesh (STL, 3MF) and Test (FreeCAD's test
runner). Assembly, FEM, TechDraw, Spreadsheet, Draft, CAM and the rest come when a
work package needs them; [DEVIATIONS.md](../../docs/DEVIATIONS.md) records why each
is off.

## The module tests

FreeCAD's `FreeCADCmd -t TestPartDesignApp` imports every test file of the suite,
and three of them import modules a GUI-less engine doesn't have: `pivy` (Coin3D's
Python binding, the 3D view's scene graph), `Draft` and PartDesign's involute gear
(a GUI script, installed only with FreeCAD's GUI). `module_tests.py` gives
those names placeholders, so the suites load; a test that actually uses one is
reported as skipped, naming the module. Everything else runs as FreeCAD's own
runner runs it. `tests/golden/module-tests.json` lists every test that doesn't
pass, its outcome and why, per OS where they differ; a new failure, a test that now
passes, or a suite that doesn't load fails the check.

## The engine (JSON-RPC)

The app's broker listens on a local endpoint (Unix socket, or named pipe on
Windows) and starts `FreeCADCmd <stage>/triage/triage_cad_engine.py --pass --connect
<endpoint>` (FreeCAD hands everything after `--pass` to the script). The engine
connects, says Hello (`triage-cad-engine <FreeCAD version> <pid>`) and answers
JSON-RPC 2.0 requests one at a time in P0-4 frames: `0x30` request, `0x31` response,
and before a response its `0x32` mesh frames (one object each: positions, triangles
grouped by B-rep face, edge polylines; layout in `triage_cad/tessellation.py`).

| Method | Does |
|---|---|
| `engine.info` | FreeCAD, OpenCASCADE and Python versions, modules |
| `document.open` / `new` / `close` / `list` / `save` | documents (opened hidden, with undo on) |
| `document.tree` | the feature tree: objects, parents, children, state, what the 3D view draws |
| `document.recompute` | FreeCAD's recompute (`force`: every feature), with each invalid object's message |
| `document.undo` / `redo` | FreeCAD's own undo |
| `document.tessellate` | meshes of what the view draws (or the named objects) at a chordal deviation |
| `object.properties` / `object.setProperty` | properties as JSON (quantities with units, enums with options, placements …); a set is one undo step, then a recompute |

`app/src/vs/triage/common/cad/cadEngine.ts` is the app's side of the protocol;
`app/engine-tests/src/cadEngine.test.ts` runs the staged engine under the P0-4
supervisor (CI's CAD workflow, `TRIAGE_REQUIRE_CAD=1`).
