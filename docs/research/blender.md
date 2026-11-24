# Teardown: Blender 5.3

**Target:** `blender-5.3.0-linux-x64.tar.xz` from download.blender.org.

**Method:** REA (exports, ELF notes, desktop inventory), `readelf` for dynamic
dependencies, embedded source-path strings for a module map, and direct reading of
the shipped Python layer. Blender's official builds are stripped and have no
debug-symbols package. A runtime API dump (running Blender headless) was blocked
by the session's safety policy, so everything here is static.

Legend: **[O]** observed · **[I]** inferred · **[D]** documentation · **[?]** unknown.

## 1. Packaging: one big native binary plus bundled engines

| Fact | Basis |
|---|---|
| 1.3 GB install; 4,870 files | [O] desktop inventory |
| `blender` is a single **197 MB ELF**, RUNPATH `$ORIGIN/lib` | [O] |
| Exports **1,686 symbols, almost all CPython C API**. **CPython 3.13 is linked statically** (`libpython3.13.a` ships for extension builds; no `libpython` NEEDED) | [O] + [I] |
| Built-in Python modules: `mathutils` (+bvhtree, kdtree, geometry, interpolate, noise), `aud` (audio), `manta_main` (Mantaflow) | [O] `PyInit_*` |
| `bpy` is registered internally (no exported `PyInit_bpy`) | [O] / [D] |
| Build-id `47dadef2…`, annobin notes (RHEL-family toolchain) | [O] |

**Linked engines** [O NEEDED]: oneTBB · Vulkan + X11/Wayland (GHOST) · OpenXR ·
Embree 4, HIP-RT, oneAPI/SYCL (Cycles) · OpenSubdiv · OpenVDB · OSL · MaterialX ·
USD · OpenTimelineIO · OpenImageIO, OpenColorIO 2.5, OpenEXR, OpenImageDenoise 2.5 ·
Ceres. **Statically inside:** Bullet (rigid bodies), Mantaflow (fluids) [O strings].
`libJolt.so` ships without an observed consumer [?].

## 2. Module map from embedded source paths

The binary embeds **970 distinct source paths** (from assert and log strings).
This is a broad but partial sample, since only files with such strings appear
[O, partial coverage]:

| Files | Module | Files | Module |
|---|---|---|---|
| 173 | `editors` (sculpt_paint 41, interface 13, asset 12, animation 11, space_node 10...) | 25 | `blenlib` |
| 112 | `blenkernel` (data model and core ops) | 23 | `imbuf` |
| 83 | `nodes` (geometry 24, shader 23, function 14, composite 7) | 22 | `windowmanager` |
| 82 | `intern/cycles` (path tracer) | 21 | `intern/libmv` (motion tracking) |
| 72 | `io` (USD 27, Alembic 16, OBJ 7, PLY 5, STL 5, FBX 3, Gaussian splats, OTIO, CSV) | 18 | `makesrna` (reflection) |
| 57 | `gpu` (GPU abstraction) | 16 | `extern/audaspace` |
| 43 | `intern/shaders` | 14 | `python` (bpy) |
| 37 | `extern/mantaflow` | 13 | `geometry` |
| 30 | `draw` (viewport engines) | 12 | `bmesh` |
| 27 | `compositor` | 11 | `intern/ghost` (windowing) |

**Python UI layer** (shipped as readable source, 822 files, 291,766 lines) [O]:
**273 Panels, 505 Menus, 348 Operators**, 46 UILists, 39 PropertyGroups, 27 Headers.
The whole Blender UI layout is Python over the RNA reflection API. Many more
operators are defined in C.

Reflection: hundreds of `RNA_def_*` and `rna_*` strings plus `DNA_`/`SDNA` [O].
RNA drives every UI widget, Python property and animation channel. DNA is the
`.blend` struct layout.

## 3. Automation surfaces [D]

- `blender --background --python script.py` for headless renders and conversions.
- `bpy` as a pip module (behaves like background mode with `--factory-startup`).
- Formats: `.blend`, glTF 2.0, USD, FBX, OBJ, STL, PLY, Alembic.

## 4. What Triage takes from Blender

1. **UX model for the 3D workspace:** a fast viewport with gizmos, an outliner, a
   properties editor driven by reflection, non-destructive modifier-style stacks,
   node graphs, and every action as a scriptable operator. Triage's
   schema-driven model (PLAN §4.3) is the "RNA" idea.
2. **Render and mesh engine process (optional):** photoreal product renders and
   turntables with Cycles, plus mesh, sculpt and organic modeling, exchanged with
   Triage's model through glTF/USD with stable IDs in custom properties.
3. **Not the CAD core.** Exact parametric geometry comes from FreeCAD's engine
   ([freecad.md](freecad.md)). Blender meshes can't round-trip to STEP.
4. **Physics lesson:** Blender uses Bullet (maximal-coordinate rigid bodies).
   Jointed mechanisms in Triage use MuJoCo's reduced coordinates instead.

## 5. Unknowns and limits

- [?] Full module and file inventory. Only files with embedded strings were
  observed, and there are no debug symbols.
- [?] Exact RNA and operator counts in C. A headless `bpy` dump needs permission
  to execute the downloaded binary.
- [?] Purpose of the bundled `libJolt.so`.
