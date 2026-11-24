# engines/cad/: FreeCAD engine

FreeCAD fork (App layer, no GUI) run headless as Triage's CAD engine
([ADR 0002](../../docs/adr/0002-absorb-engines-headless.md), [research](../../docs/research/freecad.md)).
Arrives in ROADMAP **P2-1** (fork builds on Linux and Windows), then P2-2 (JSON-RPC server).

Planned layout: `upstream/` · `patches/` · `triage/` (RPC module).
