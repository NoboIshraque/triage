# engines/eda/: KiCad engine

KiCad fork run headless as Triage's EDA engine ([ADR 0002](../../docs/adr/0002-absorb-engines-headless.md),
[research](../../docs/research/kicad.md)). Arrives in ROADMAP **P1-1** (fork builds
on Linux with GCC and Windows with MSVC + vcpkg), then P1-2 (headless host), P1-3
(Stream GAL) and P1-6 (simple edits).

Planned layout: `upstream/` · `patches/` · `triage/` (`stream_gal/`, `remote_tools/`, `api/`).
