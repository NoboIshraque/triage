# ADR 0002: Run KiCad, FreeCAD and Blender as hidden engines behind Triage's own tabs

- **Status:** Accepted, 2026-11-24 (owner: "Yes, that's fine"). Proposed 2026-11-23.
- **Related:** [ADR 0001](0001-standalone-app-on-vscode-codebase.md) (the app is a VS Code fork),
  [ADR 0003](0003-boards-and-windows.md) (boards and Windows)

## In plain words

**Triage is one app, and you only ever see Triage.** The code, the schematic, the
PCB, the 3D design and the simulation are tabs in its window, all working on one
project.

Behind those tabs, Triage runs the working parts (the *engines*) of three existing
programs, invisibly, as helpers:

- **KiCad's engine** does the electronics work: connections, the PCB router,
  design-rule checks, Gerber files for manufacturing.
- **FreeCAD's engine** does precise 3D modeling: sketches, features, assemblies,
  STEP files.
- **Blender's engine** makes photo-quality renders (optional).

Their own windows never open. When you drag a part or route a track in Triage's
PCB tab, Triage sends that action to KiCad's engine, which does the work and sends
back what to draw. Think of a car: you drive with Triage's steering wheel and
dashboard, and KiCad, FreeCAD and Blender are the engine under the hood.

**Why:** those engines hold decades of work (routers, rule checkers, a 3D modeling
kernel). Rewriting them would take a large team years. Reusing them lets the two of
us spend our time on what's new: one window, designs linked across code, circuit
and 3D, and the simulation. Your files stay normal KiCad and FreeCAD files, so they
still open in those programs if you ever need them.

## Context

Triage must do what KiCad, a parametric CAD tool and Blender do, inside one window,
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
process** that Triage builds from the upstream source with a small patch set:

1. **EDA engine (KiCad):** a headless build of KiCad's board and schematic models,
   connectivity, router, DRC, zone filler, importers and exporters, plotters,
   simulator glue and jobs. It talks to Triage through
   - **Stream GAL**, a new GAL backend that serializes draw calls into display
     lists for Triage's GPU canvas, so rendering is identical to KiCad,
   - **interactive tools** run headlessly, either as **remote tools** (Triage
     canvas input drives KiCad's tool framework) or by **hosting** pieces such as
     the router directly through their adapters. A spike in ROADMAP P1-6 picks the
     path (ADR 0004), and
   - KiCad's **protobuf API**, extended, for everything else. Dialogs are rebuilt
     in Triage's UI.
2. **CAD engine (FreeCAD App layer):** documents, Part (OCCT), PartDesign,
   Sketcher, Assembly (Ondsel solver), Materials, Import/Export, FEM and TechDraw
   behind a JSON-RPC server using FreeCAD's Python API, with tessellation streamed
   to Triage's 3D viewport.
3. **Render engine (Blender, optional):** Cycles renders and mesh/sculpt operations
   through `bpy`/background mode.
4. **Sim engine (Triage's own):** the co-simulation kernel with ngspice, MuJoCo,
   avr8js, rp2040js, QEMU (ESP32), Renode and the Raspberry Pi Python bridge.

**Staging: inside Triage from the start.** Each engine first appears as in-app
views with simple edits (electronics in P1, 3D in P2), then gains full in-app
editing (P5, P6). Until then, "Edit in KiCad" or "Edit in FreeCAD" can open the
same files in the stock window as a **temporary fallback**; Triage reloads them on
save. The fallback leaves the default UI once full editing lands (ROADMAP).

## Consequences

Good: years of algorithm work reused. KiCad and FreeCAD file compatibility is
exact. The engines keep improving upstream.

Costs: upstream forks to keep merged (VS Code, KiCad, FreeCAD, plus Espressif's
QEMU from ADR 0003); heavy native builds on Windows and Linux (CI caching
essential); KiCad's tools are coupled to wx, so driving them headlessly is the main
technical risk and gets an early spike (ROADMAP P1-6).

License note (owner's decision: not a focus): the combined app is distributed as
GPL-3.0-or-later, which is compatible with everything it reuses.
