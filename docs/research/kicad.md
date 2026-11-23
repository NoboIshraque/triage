# Teardown: KiCad 10

**Target:** KiCad 10.0.8 for Ubuntu 24.04 x64 from the official PPA
(`kicad_10.0.8~ubuntu24.04.1_amd64.deb`), plus `kicad-demos` as a test corpus.
KiCad is GPL-3.0-or-later.

**Why KiCad and not something else:** Altium, OrCAD and Fusion Electronics are
closed, so we couldn't integrate with them at this depth. EasyEDA is popular
with students but cloud-first and proprietary. KiCad has open, documented file
formats, a CLI, a protobuf IPC API, a Python API and big libraries. It is the
right foundation.

Legend: **[O]** observed by REA · **[I]** inferred · **[D]** documentation · **[?]** unknown.

## 1. Packaging: a launcher plus loadable "kifaces"

| Fact | Basis |
|---|---|
| `bin/` holds **seven `.kiface` shared objects** (`_eeschema` 25 MB, `_pcbnew` 41 MB, `_cvpcb`, `_gerbview`, `_pl_editor`, `_pcb_calculator`, `_kipython`) | [O] |
| **Every kiface exports a single entry symbol, `KIFACE_1`** | [O] exports |
| `eeschema`, `pcbnew`, `gerbview`, `pcb_calculator` and `pl_editor` are **identical 88 KB stubs**. Each loads its kiface (KiCad's single_top launcher) | [O] sizes / [I] |
| `kicad` (5 MB) is the project manager. It hosts all kifaces in one process (KiCad's "KIWAY" design) | [I] + [D] |
| Shared libraries: `libkicommon` (common code, settings, API server), `libkigal` (graphics), `libkiapi` (protobuf API types), `libkicad_3dsg` (3D scene graph) | [O] |
| **`_pcbnew.so` (the Python module) is a symlink to `../../../bin/_pcbnew.kiface`**, which exports both `KIFACE_1` and `PyInit__pcbnew` | [O] |

**Lesson:** KiCad's Python `pcbnew` API is not a separate binding layer. It is
the PCB editor binary itself, loaded into Python through SWIG. Scripting
therefore reaches all of PCB editing, but it is tightly coupled to KiCad's
internals and is being replaced by the IPC API [D].

## 2. The IPC API (protobuf over nng)

| Fact | Basis |
|---|---|
| `libkiapi.so` exports **6,486 symbols**, including protobuf descriptor tables for **15 `.proto` files** | [O] |
| `libkicommon` links **`libnng.so.1`** and `libprotobuf.so.32`, and contains `KICAD_API_SERVER` (`common/api/api_server.cpp`), `KINNG_REQUEST_SERVER`, `nng_listener_create` and the socket template `ipc://{}` | [O] strings/exports |
| The request server runs on a `std::thread`. Requests reach `KICAD_API_SERVER::handleApiEvent(wxCommandEvent&)`, which means **API calls are posted to the wx UI thread and serialized there** | [I] from symbol names |
| Handlers register through `RegisterHandler(API_HANDLER*)`, per editor | [O] symbols |
| The KiCad 9 and 10 IPC API only talks to a **running GUI instance**. Headless `kicad-cli api-server` is post-v10 work (KiCad 11 is expected around Feb 2027) | [D] |

The 15 API schema files:

```
board/board.proto              board/board_commands.proto     board/board_types.proto
common/envelope.proto          common/commands/base_commands.proto
common/commands/editor_commands.proto  common/commands/project_commands.proto
common/commands/variant_commands.proto common/types/base_types.proto
common/types/embedded_files.proto      common/types/enums.proto
common/types/project_settings.proto    common/types/variants.proto
schematic/schematic_commands.proto     schematic/schematic_types.proto
```

### Plugin and extension surfaces (`share/kicad/schemas/`)

- **`api.v1.schema.json`**: IPC API plugin manifest. A plugin has an
  `identifier`, a `runtime.type` of `python` or `exec`, and `actions[]`, each
  with `scopes`, an `entrypoint`, light and dark icons, and `show-button`. KiCad
  launches the plugin as a separate process that connects back over the socket [O + D].
- **`kicad-remote-provider-metadata-v1.schema.json`** (new in 10): a remote
  **parts provider** protocol. It defines `api_base_url`, `panel_url`
  (embedded web UI), `auth` (`none` or `oauth2`), capabilities `web_ui_v1`,
  `parts_v1`, `direct_downloads_v1` and `inline_payloads_v1`, and
  `supported_asset_types` [O].
- `pcm.v1/v2.schema.json`: Plugin and Content Manager. Legacy SWIG action
  plugins and footprint wizards ship in `share/kicad/scripting/plugins/` [O].

**Opportunity:** our app can act as a **KiCad remote parts provider** and serve
simulation-ready "smart parts" (symbol, footprint, 3D model and sim model)
directly into KiCad's library browser.

## 3. Engines KiCad embeds

| Engine | How KiCad couples to it | Basis |
|---|---|---|
| **ngspice** (circuit sim) | **Not linked.** `_eeschema.kiface` contains the strings `libngspice.so.0`, "libngspice search path", "libngspice path found in" and resolves `ngSpice_Init`, `ngSpice_Circ`, `ngSpice_Command`, `ngSpice_AllPlots`, `ngSpice_AllVecs`, `ngSpice_CurPlot`, `ngSpice_running`, `ngSpice_LockRealloc`/`UnlockRealloc` by name. It also loads XSPICE code models (`codemodel '{}'`). So it is **dlopen'd at runtime** | [O] strings + no NEEDED / [I] |
| **OCCT** (B-rep CAD kernel) | `_pcbnew.kiface` links TKSTEP, TKXDESTEP, TKIGES, TKSTL, TKBRep, TKMesh, TKXCAF, TKBO and others. Used for STEP/IGES/STL export and 3D models | [O] NEEDED |
| OpenGL GAL | `libkigal` with GLAD loaders, GLU and Cairo. GPU canvas with a Cairo fallback | [O] |
| git | `libgit2.so.1.7` in kicommon, eeschema, pcbnew and kicad. Built-in version control | [O] |
| Databases | `libodbc.so.2` in eeschema (database symbol libraries) | [O] |
| 3D mouse | `libspnav.so.0` | [O] |
| Python 3.12 | linked by pcbnew, kipython and kicommon (scripting console and plugins) | [O] |
| Web content | `wx webview` in eeschema and kicad (for example the remote provider panel) | [O] |
| Other libraries in pcbnew | tinyspline (B-splines), parson-style JSON, **zint** barcodes (`ZBarcode_*`) | [O] exports |

## 4. `kicad-cli`: the headless automation surface

Subcommand tokens found in the binary [O]:

- `pcb export`: `gerbers`, `drill`, `pos`, `svg`, `dxf`, `hpgl`, `gencad`,
  **`ipc2581`**, **`odb`** (ODB++), `ipcd356`, **`step`**, `stpz`, **`glb`**,
  `vrml`, `stl`, `ply`, `xao`, `brep`, `u3d`, `3dpdf`
- `pcb drc`, **`pcb render`** (3D view to PNG or JPEG), `sch erc`, `sch export`
  (netlist, BOM, PDF, SVG...), `sym`/`fp` export and upgrade
- **`jobset run`**: KiCad's batch output pipelines, so one call can produce a
  full fab package

`kicad-cli` itself links only wx core/base and kicommon. It must load the kifaces
at runtime to do the work [I].

## 5. File formats

KiCad's native files (`.kicad_pro` JSON, plus S-expression `.kicad_sch`,
`.kicad_pcb`, `.kicad_sym` and `.kicad_mod`) are text, documented on
dev-docs.kicad.org, and diff-friendly in git. **They are our electronics source of
truth.** The `kicad-demos` package (36 real projects, 341 MB unpacked) is our round-trip test
corpus.

## 6. What we take from KiCad

1. **Keep KiCad-native files** so users can always open their project in
   KiCad. There is no lock-in, and our editors can start read-only.
2. **Phase A: KiCad as a companion editor.** Launch KiCad, sync over the IPC API
   (selection cross-probing, live board queries for our 3D view), and run kicad-cli
   for ERC, DRC, exports, renders and jobsets.
3. **Phase B+: our own schematic, then PCB editor** in web tech. They follow
   KiCad's architecture lessons: GPU canvas with cached geometry (GAL), tool
   framework, router as a separate subsystem.
4. **Match KiCad's API threading.** All IPC calls serialize on KiCad's UI thread,
   so batch requests and never poll in tight loops.
5. **Simulation:** ngspice through its shared-library API is battle-tested in
   KiCad. We use the same library with its co-simulation hooks (see
   [simulators.md](simulators.md)).

## 7. Unknowns and limits

- [?] Exact IPC message semantics. Read the `.proto` sources and the kicad-python
  (`kipy`) docs before implementing the bridge.
- [?] Whether `kicad-cli api-server` lands in 10.x or 11. Track the KiCad 11 cycle.
- The UI-thread serialization is inferred from symbol names, not observed at runtime.
- The desktop inventory found no runtime families. REA's detectors target
  Electron, .NET, Unity, Godot and similar; plain native wx apps are outside them.
