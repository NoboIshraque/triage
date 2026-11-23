# Teardown: Blender 5.3

**Target:** `blender-5.3.0-linux-x64.tar.xz` from download.blender.org (GPL).

Legend: **[O]** observed by REA or format-aware tools · **[I]** inferred · **[D]** documentation · **[?]** unknown.

## 1. Packaging: one big native binary plus bundled engines

| Fact | Basis |
|---|---|
| 1.3 GB install; 4,870 files (REA probe coverage partial at the 8 MiB read budget) | [O] desktop inventory |
| `blender` is a single **197 MB ELF** with RUNPATH `$ORIGIN/lib` | [O] readelf |
| It exports **1,686 dynamic symbols, almost all CPython C API** (`Py*`, `_Py*`). Only 5 are not Python-related (aligned-allocator and MP3-encoder helpers) | [O] REA exports |
| No `libpython` NEEDED entry, and `5.3/python/lib/libpython3.13.a` ships. **CPython 3.13 is linked statically into the executable** and its C API is exported so bundled extension modules (numpy and others) resolve against the binary | [O] + [I] |
| Built-in Python modules registered in the binary (`PyInit_*`): `mathutils` (+`bvhtree`, `kdtree`, `geometry`, `interpolate`, `noise`), **`aud`** (Audaspace audio), **`manta_main`** (Mantaflow fluids) and core CPython modules | [O] exports |
| No exported `PyInit_bpy`. `bpy` is registered internally at startup | [O] absence of export / [D] |
| Build-id note `47dadef2…`, ABI tag and `.gnu.build.attributes` (annobin, so likely a RHEL-family toolchain) | [O] ELF notes / [I] |

### Engines the binary links (NEEDED) [O]

| Area | Libraries |
|---|---|
| Threading | oneTBB (`libtbb`, `tbbmalloc`, `tbbmalloc_proxy`) |
| GPU / windowing | **Vulkan** loader, X11/Xi/Xfixes/Xrender, xkbcommon. GHOST windowing has X11 and **Wayland** backends [O strings] |
| VR | OpenXR loader |
| Ray tracing (Cycles) | **Embree 4** (CPU), **HIP-RT** (AMD), **oneAPI/SYCL** AOT kernels (Intel). CUDA and OptiX are loaded at runtime [I strings] |
| Geometry | **OpenSubdiv** (CPU+GPU), **OpenVDB** (volumes) |
| Shading / materials | **OSL** (compiler, exec, query, noise), **MaterialX** |
| Scene interchange | **USD** (`libusd_ms`, monolithic), OpenTimelineIO |
| Imaging | OpenImageIO, OpenColorIO 2.5, OpenEXR/Imath, OpenImageDenoise 2.5 (CPU/CUDA/HIP/SYCL devices), OpenJPH |
| Solvers | **Ceres** (motion tracking) |
| Bundled but not NEEDED | `libJolt.so` (Jolt Physics): no reference from the main binary was observed, so its consumer is unknown [?]. `libSDL3`; draco/ktx/meshoptimizer bridges for glTF compression |

### Physics and simulation inside Blender [O strings / I]

- **Bullet** (`btRigidBody`, `btDiscreteDynamicsWorld`) for rigid-body simulation, statically linked.
- **Mantaflow** for smoke and fluid.
- Cloth, soft-body and particle solvers are native code (Blender's own).
- **Geometry Nodes** (`NodesModifier`) are a procedural node system.

### Python and add-on layer [O]

- `5.3/scripts/startup` (UI is Python: `bl_ui`, `bl_operators`), `scripts/modules`
  (`bpy`, `bpy_extras`, `gpu_extras`, `addon_utils`, `_rna_info`), `addons_core`
  (Cycles UI, glTF 2.0, FBX, Rigify, Hydra Storm, Node Wrangler...), and
  `extensions/system` (the Blender Extensions platform).
- Bundled site-packages: numpy 2.3.4, **pxr (USD)**, OpenImageIO, PyOpenColorIO,
  MaterialX, OpenEXR, openvdb, Cython, requests, zstandard.
- Reflection: hundreds of `RNA_def_*` and `rna_*` strings and `DNA_`/`SDNA`. RNA
  is the reflection layer every UI widget, Python property and animation channel
  goes through. DNA is the struct layout stored in `.blend` files [O strings / D].

## 2. Automation surfaces [D]

- `blender --background --python script.py` runs headless (rendering, conversion).
- `bpy` as a pip module ("Blender as a Python module"). It behaves like
  background mode with `--factory-startup` and is pinned to one Python version
  per release. It is not officially supported for distribution.
- File formats: `.blend` (DNA), glTF 2.0, USD, FBX, OBJ, STL, PLY, Alembic.

## 3. Why Blender is not our CAD core

Blender is a **polygon and subdivision modeler, renderer and animation suite**.
Engineering enclosures need **B-rep parametric CAD**: exact dimensions, sketches
with constraints, fillets and chamfers, shells, holes, tolerances, and STEP output
for manufacturing. Blender meshes can't round-trip to STEP faithfully, and
Blender's modeling is not dimension-driven. FreeCAD, Fusion and Onshape all sit
on B-rep kernels (OCCT, Parasolid). **So the core of our 3D workspace is OCCT 8**
(LGPL-2.1 with exception; WebAssembly builds covered in OCCT 8.0.1 [D]).

## 4. What we take from Blender

1. **The UX ideas:** a 3D viewport with gizmos and fast navigation; an outliner
   tree; a properties editor driven by reflection (our "RNA" becomes the
   project-model schema); non-destructive **modifier/feature stacks**; **node
   graphs** for procedural logic; and **Python-first automation**, since every UI
   action is an operator callable from scripts.
2. **The reflection pattern:** one schema powers UI, scripting, undo,
   serialization and animation. We generate our TS and Python APIs, property
   panels and file schema from one model definition (see PLAN §4.3).
3. **Blender as an optional companion (separate process):**
   - photoreal product renders and turntable animations with Cycles, driven
     by `blender -b` scripts;
   - mesh and organic modeling (grips, ergonomic shells, sculpting), exchanged
     through glTF/USD with our object IDs in `extras`/custom properties so
     round-trips keep links;
   - USD as a future scene-interchange format.
4. **Physics lesson:** Blender itself uses Bullet for rigid bodies, while
   robotics simulators pick MuJoCo-style reduced-coordinate solvers for jointed
   mechanisms. We follow robotics practice (see [simulators.md](simulators.md)).

## 5. Unknowns and limits

- [?] Purpose of the bundled `libJolt.so`. No consumer was observed.
- CUDA, OptiX and Vulkan runtime selection was not observed (no execution).
- Strings-based facts are inferences about linked code, not proof of runtime use.
