# Research: how VS Code, KiCad, FreeCAD, Blender and the simulators are built

Before planning one app that does the work of all of them, we took apart the real,
shipped Linux builds with **REA (Reverse Engineer Anything)**. Round 2 used REA's
**unbounded mode**, with no analysis timers and no fixed size caps (skill
`rea-full-breakdown`, vendored in `.claude/skills/`).

| Report | What it covers |
|---|---|
| [vscode.md](vscode.md) | Code-OSS process model, preload bridge, MessagePort IPC, native modules, fuses, where Triage plugs into the fork, unbounded rounds 2 and 3 (§5) |
| [data/vscode-round3.tsv](data/vscode-round3.tsv) | Round 3, one REA run per VS Code file: status, semantic node count and Evidence IDs per file |
| [kicad.md](kicad.md) | **Full debug-symbol breakdown**: ~158k functions placed in source files, engine/UI split, the 68-method GAL boundary, router/DRC/IO sizes, IPC API, kicad-cli |
| [freecad.md](freecad.md) | FreeCAD 1.1 as the parametric CAD engine: **App (29.3 MB) vs Gui (28.3 MB)** split across 61 libraries |
| [blender.md](blender.md) | Monolithic binary with embedded CPython, bundled engines, module map from 970 embedded source paths, Python UI layer counts |
| [simulators.md](simulators.md) | ngspice co-sim API, simavr, avr8js/rp2040js, **Renode complete (1,248 peripheral models, time framework)**, MuJoCo C API, **Wokwi 4.1.0**, **board emulation for ESP32, Arduino and Raspberry Pi** (§7) |
| [market-and-standards.md](market-and-standards.md) | Competitors, the gap Triage fills, simulator-game lessons, standards, sources |
| [evidence-ledger.md](evidence-ledger.md) | Every REA Evidence ID and artifact SHA-256 for both rounds |

## Method

1. **Targets:** official Linux x64 builds.

   | Target | Version and package |
   |---|---|
   | VS Code | VSCodium 1.143.17232 (an MIT build of Code-OSS, the same source as VS Code) |
   | KiCad | 10.0.8 plus `kicad-dbg` debug symbols (official PPA) |
   | FreeCAD | 1.1 pre-release (official daily PPA) |
   | Blender | 5.3.0 |
   | Renode | 1.16.1 |
   | ngspice | 42 (Ubuntu) |
   | simavr | 1.6 (Ubuntu) |
   | MuJoCo | 4.0.1 |
   | npm packages | avr8js 0.21.1, rp2040js 1.4.2, eecircuit-engine 1.9.0 |
   | Wokwi for VS Code | 4.1.0 (Open VSX) |
2. **Static analysis.** REA read export tables, ELF notes, complete symbol tables,
   Electron fuses, JavaScript module graphs, preload/IPC facts and .NET metadata.
   `addr2line`, `readelf` and `strings` filled in source-file placement, dynamic
   dependencies and embedded paths. Running the downloaded apps (for example a
   headless Blender API dump) was blocked by the session's safety policy, so
   no runtime probes were made.
3. **Evidence discipline:** each fact is tagged observed, inferred,
   documentation or unknown, and tied to an Evidence ID. Coverage limits are stated.
4. **Licenses are out of scope** for this research (owner's decision, 2026-11-23).

## Reproduce

```bash
cd ../rea && git checkout claude/unified-engineering-platform-jn5rmk \
  && HUSKY=0 npm ci && npm run build:cached && cd -
REA=../rea/scripts/rea-unbounded.sh scripts/research/teardown.sh /abs/path/to/workdir
```
