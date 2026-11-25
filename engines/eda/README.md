# engines/eda/: KiCad engine

KiCad fork run headless as Triage's EDA engine ([ADR 0002](../../docs/adr/0002-absorb-engines-headless.md),
[research](../../docs/research/kicad.md)). ROADMAP **P1-1 … P1-7**.

| Path | What |
|---|---|
| `upstream.json` | the pinned KiCad release (10.0.8, tag and commit) |
| `upstream/` | KiCad's source at that commit (git-ignored; `build.mjs fetch`) |
| `patches/` | small changes to KiCad's files (GUIDELINES §6): `0001` build hooks for Triage's code, `0002` view layer setup without a wx panel, `0003` vcpkg manifest without wxPython |
| `triage/` | Triage's code, built inside KiCad's CMake tree: the engine host `triage-eda-engine` (`engine/`), the board and schematic faces compiled into KiCad's kifaces (`pcb/`, `sch/`), **Stream GAL** (`stream_gal/`) and the `triage.eda.v1` protobuf API (`api/proto/`) |
| `tests/` | the kicad-demos corpus checks, the renderer harness (`render.mjs`) and the pixel comparison with kicad-cli's plots (`compare.mjs`), with their golden files |
| `build/<os>/` | the CMake build and `stage/bin/` (git-ignored) |

```sh
node engines/eda/build.mjs            # fetch, prepare, configure, build, stage
node engines/eda/build.mjs test       # kicad-cli and the engine on KiCad's 36 demo projects
node engines/eda/tests/compare.mjs    # Triage's drawings vs kicad-cli's SVG plots (Playwright)
```

Linux: `scripts/dev/setup.sh --eda` installs KiCad's build dependencies from
Ubuntu's archive. Windows: `scripts/dev/setup.ps1 -Eda -DevShell` sets up vcpkg
(KiCad's dependencies build from upstream's `vcpkg.json`) and ccache, then run the
build from that developer shell. Add `--ccache` to use the compiler cache.

## How the engine works

`triage-eda-engine` is a console program set up like kicad-cli: KiCad's program
object, settings and library tables, and a KIWAY that loads the pcbnew and
eeschema kifaces. Built with `KICAD_TRIAGE`, each kiface hands out an engine face
(`KIFACE_TRIAGE_ENGINE`) that opens boards or schematics and gives each one what
KiCad's editor builds around its canvas, minus the window: a `PCB_VIEW` or
`SCH_VIEW` with the editor's layer setup, KiCad's own painter, and the Stream GAL
in place of the OpenGL GAL. The Stream GAL records every cached group the view
creates (one per item per layer) as a display list of triangles, capsule
segments, circles, arcs and bitmaps; Triage's canvas draws those on the GPU.

The engine talks to its broker over the P0-4 engine connection (`--connect
<endpoint>`): `triage.eda.v1.Request` frames in, `Response` frames out, and
binary display-list frames before the response that produced them. The formats
are documented in `triage/engine/host.cpp` and `triage/stream_gal/display_list.h`.
