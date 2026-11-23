# Research: how VS Code, KiCad, Blender and the simulators are built

Before planning one app that does the work of four, we took apart the real,
shipped Linux builds of each tool with **REA (Reverse Engineer Anything)**, plus
official docs and market research.

| Report | What it covers |
|---|---|
| [vscode.md](vscode.md) | Code-OSS process model, the 26-member preload bridge, MessagePort IPC, native modules, Electron fuses |
| [kicad.md](kicad.md) | Launcher + kiface plugin design, the protobuf/nng IPC API (15 protos), kicad-cli, ngspice and OCCT coupling, plugin and parts-provider schemas |
| [blender.md](blender.md) | Monolithic binary with embedded CPython, bundled engines (Embree, OSL, USD, OpenVDB...), Bullet and Mantaflow, and why Blender is not our CAD core |
| [simulators.md](simulators.md) | ngspice co-sim API, simavr IRQ model, avr8js/rp2040js timing loops, Renode co-sim protocol and `.repl` wiring, MuJoCo C API |
| [market-and-standards.md](market-and-standards.md) | Competitors, the gap we fill, simulator-game lessons, standards, license map, sources |
| [evidence-ledger.md](evidence-ledger.md) | Every REA Evidence ID and artifact SHA-256, cost of each run, open questions |

## Method

1. **Targets:** official Linux x64 builds: VSCodium 1.143.17232 (MIT build
   of Code-OSS), Blender 5.3.0, KiCad 10.0.8 (official PPA), Renode 1.16.1,
   ngspice 42 and simavr 1.6 (Ubuntu 24.04), MuJoCo 4.0.1, and npm packages
   avr8js 0.21.1, rp2040js 1.4.2, @wokwi/elements 1.9.2 and eecircuit-engine 1.9.0.
2. **Static analysis only.** Nothing downloaded was executed. REA read export
   tables, ELF notes, Electron fuses, JavaScript module graphs, preload/IPC
   facts and .NET metadata. Standard tools (`readelf`, `strings`, package
   metadata) filled in dynamic dependencies and licenses.
3. **Evidence discipline (from the REA skill):** each fact is tagged
   observed, inferred, documentation or unknown, and tied to an Evidence ID.
   Coverage limits are stated rather than hidden.
4. **Legal scope:** we analyzed open-source or permissively distributed builds
   only. Microsoft's branded VS Code (its license restricts reverse
   engineering) was replaced by VSCodium, which comes from the same source under
   MIT. Proprietary simulators (LTspice, Proteus, Wokwi's cloud, BeamNG, KSP) were
   studied only through public docs and behavior. Our implementation is
   clean-room: we learn the architecture and write our own code, or use the
   open-source engines under their licenses.

## Reproduce

```bash
# build REA from the sibling repo (or let the script use npx rea-agents@6.7.0)
cd ../rea && HUSKY=0 npm ci && npm run build:cached && cd -
REA="node ../rea/scripts/rea.mjs" scripts/research/teardown.sh /abs/path/to/workdir
```
