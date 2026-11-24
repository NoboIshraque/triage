# Teardown: FreeCAD 1.1 (the parametric CAD engine)

**Why FreeCAD is here:** Blender is a mesh, render and animation suite, not
engineering CAD (see [blender.md](blender.md)). Product enclosures need **parametric
B-rep CAD**: constrained sketches, features, assemblies and STEP output. FreeCAD is
the leading open-source parametric CAD, built on OCCT, with an engine that
runs **without its UI** (`FreeCADCmd`, Python). It is the natural engine for
Triad's mechanical workspace, while Blender contributes rendering, mesh tools
and UX ideas.

**Target:** `libfreecad-daily-python3-1.1_1.1~pre1~202508270404~ubuntu24.04.1_amd64.deb`
(FreeCAD 1.1 pre-release, built 2025-08-27, official FreeCAD daily PPA). 61 shared
libraries, 139 MB.

**Method:** REA unbounded `inspect-native-exports` on every library (FreeCAD
exports its C++ API, so export tables are complete class/method inventories),
plus `.text` sizes from `readelf`. Evidence IDs are in
[evidence-ledger.md](evidence-ledger.md).

Legend: **[O]** observed · **[I]** inferred · **[D]** documentation · **[?]** unknown.

## 1. The architecture is split engine/UI by design

Every FreeCAD module ships as **two libraries: an App (engine) library and a Gui
library** [O]. The core is `libFreeCADBase` + `libFreeCADApp` (no UI) and
`libFreeCADGui` (Qt + Coin3D scene graph).

| | Libraries | Exported functions | Code (.text) |
|---|---|---|---|
| **Engine (App)** | 39 | 56,698 | **29.3 MB** |
| **UI (Gui)** | 22 | 48,665 | **28.3 MB** |

Two of the 63 inspected files were symlinks and one a static archive (not analyzable,
not missing) [O].

## 2. Module map (engine vs UI size)

| Module | Engine code | Engine exports | UI code | UI exports |
|---|---|---|---|---|
| Core (Base, App / Gui) | 5.07 MB | 11,651 | 9.59 MB | 20,371 |
| TechDraw (2D drawings) | 3.22 MB | 4,361 | 4.60 MB | 5,292 |
| **Part** (OCCT shapes, booleans, fillets) | 3.67 MB | 9,208 | 2.93 MB | 4,117 |
| **Sketcher** (constraint solver) | 1.61 MB | 2,393 | 3.22 MB | 3,983 |
| Mesh | 2.10 MB | 4,546 | 1.06 MB | 1,886 |
| **FEM** | 1.10 MB | 2,684 | 1.71 MB | 3,765 |
| **PartDesign** (feature modeling) | 0.83 MB | 1,675 | 1.59 MB | 3,019 |
| SMESH + StdMeshers + SMDS (FEM meshing) | 3.54 MB | 4,782 | – | – |
| **OndselSolver** (assembly solver) | 1.39 MB | 4,066 | – | – |
| **Assembly** | 0.24 MB | 530 | 0.18 MB | 327 |
| Materials | 0.69 MB | 1,877 | 0.44 MB (MatGui) | 1,101 |
| CAM (Path, area, simulators) | 1.54 MB | 2,420 | 0.22 MB | 554 |
| Spreadsheet (parameters) | 0.66 MB | 833 | 0.57 MB | 889 |
| Measure, Surface, Import, Points, Robot, Inspection, ReverseEngineering, MeshPart, flatmesh... | ~3.4 MB | ~5,400 | ~1.9 MB | ~2,900 |

## 3. What Triad takes from FreeCAD

1. **Run FreeCAD's App layer as Triad's CAD engine process.** It covers
   documents with recompute and undo, the feature tree, Part (OCCT), PartDesign,
   Sketcher with its solver, Assembly with the Ondsel solver, Materials,
   Spreadsheet parameters, Import/Export (STEP, IGES, STL...), Mesh, FEM with
   meshing, TechDraw and CAM. That is ~29 MB of engine code Triad doesn't write.
2. **Replace the Qt/Coin3D UI (~28 MB) with Triad's 3D workspace:** a GPU viewport
   (tessellation streamed from the engine), a feature tree, property panels and a
   sketcher overlay, using Blender-style UX (outliner, properties, gizmos,
   modifier-style feature stack).
3. **Control channel:** FreeCAD's embedded Python API (`FreeCAD`, `Part`,
   `PartDesign`, `Sketcher`, `Assembly`) behind a JSON-RPC server inside the engine
   process. Bulk geometry travels as binary tessellations.
4. **Assemblies to physics:** the Ondsel solver's joints map onto MuJoCo joints
   (see [simulators.md](simulators.md)). Masses and inertias come from Part's
   mass properties.

## 4. Unknowns and limits

- [?] Which App modules still pull in Qt at runtime (FreeCAD Base uses QtCore
  types). Plan for a QtCore dependency in the engine process.
- [?] Runtime behavior. Executing the downloaded build was not permitted in this
  session, so findings are static.
- The 1.1 build is a pre-release snapshot. Re-run the breakdown on the release
  Triad pins.
