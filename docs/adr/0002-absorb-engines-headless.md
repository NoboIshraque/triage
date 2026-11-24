# ADR 0002: Absorb KiCad, FreeCAD and Blender as headless engines behind Triad's UI

- **Status:** Proposed, 2026-11-23 (recommended; confirm in the first build session)

## Context

Triad must do what KiCad, a parametric CAD tool and Blender do, inside one window,
and it is built by two people (the owner and Claude). The unbounded teardown
measured the original apps:

| App | Engine (reusable) | UI (to replace) | Boundary found |
|---|---|---|---|
| KiCad 10 | 42% of pcbnew (12.4 MB code), 49% of eeschema (9.7 MB) | dialogs, widgets and frames: 21–26% | **GAL: 68 methods** (~45 to implement); router adapter `pns_kicad_iface.cpp`; protobuf IPC API |
| FreeCAD 1.1 | **29.3 MB** across 39 App libraries | 28.3 MB across 22 Gui libraries | every module is an App/Gui library pair; Python API |
| Blender 5.3 | Cycles, mesh, sculpt, geometry nodes, USD/glTF | UI is Python (273 panels, 505 menus) over RNA | `bpy`/background mode |

Rewriting those engines (PCB router, DRC, zone filler, importers, B-rep features,
constraint solver, assembly solver, path tracer) would take a large team years.
Their UIs are what make them separate apps.

## Decision

**Keep the engines, replace the UIs.** Each original app becomes an **engine
process** that Triad builds from the upstream source with a small patch set:

1. **EDA engine (KiCad):** a headless build of KiCad's board and schematic models,
   connectivity, router, DRC, zone filler, importers and exporters, plotters,
   simulator glue and jobs. It talks to Triad through
   - **Stream GAL**, a new GAL backend that serializes draw calls into display
     lists for Triad's GPU canvas, so rendering is identical to KiCad, and
   - **remote tools**, where Triad canvas input drives KiCad's tool framework, so
     the real router and editing tools run headlessly, and
   - KiCad's **protobuf API**, extended, for everything else. Dialogs are rebuilt
     in Triad's UI.
2. **CAD engine (FreeCAD App layer):** documents, Part (OCCT), PartDesign,
   Sketcher, Assembly (Ondsel solver), Materials, Import/Export, FEM and TechDraw
   behind a JSON-RPC server using FreeCAD's Python API, with tessellation streamed
   to Triad's 3D viewport.
3. **Render engine (Blender, optional):** Cycles renders and mesh/sculpt operations
   through `bpy`/background mode.
4. **Sim engine (Triad's own):** the co-simulation kernel with ngspice, MuJoCo,
   avr8js/rp2040js, Renode and QEMU.

**Staging:** before the engines are absorbed, users can open the project in stock
KiCad and FreeCAD (companion mode). Triad's own viewers come first, then in-app
editing (ROADMAP).

## Consequences

Good: years of algorithm work reused. KiCad and FreeCAD file compatibility is
exact. The engines keep improving upstream.

Costs: three upstream forks to keep merged (VS Code, KiCad, FreeCAD); heavy native
builds (CI caching essential); KiCad's tools are coupled to wx, so the
remote-tools bridge is the main technical risk and gets an early spike
(ROADMAP P3).

License note (owner's decision: not a focus): the combined app is distributed as
GPL-3.0-or-later, which is compatible with everything it reuses.
