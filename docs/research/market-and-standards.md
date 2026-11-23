# Market landscape, simulator games, standards and licenses

Researched 2026-11-23. Vendor marketing is labeled as such.

## 1. Does anything already do all of it?

**No.** No single product covers **firmware + circuit simulation + PCB + 3D
enclosure + system simulation**, let alone locally and free for students. The
closest tools each cover part of it:

| Product | Code | Circuit sim | PCB | 3D / enclosure | System sim | Notes |
|---|---|---|---|---|---|---|
| Autodesk Fusion (Electronics) | – | SPICE | ✅ | ✅ (same dataset as the PCB) | – | Strongest ECAD/MCAD story: board shape from the enclosure, two-way updates (Autodesk claims). Closed and cloud-centric |
| Altium Designer / 365 + CoDesigner | – | ✅ | ✅ (industry standard) | push/pull to MCAD | – | Expensive, Windows |
| Flux.ai | – | ✅ | ✅ browser | partial | – | Browser EDA plus AI copilot |
| Proteus (Labcenter) | partial (VSM) | ✅ SPICE | ✅ | 3D view | **MCU + SPICE co-sim** | The classic mixed-mode sim; closed, Windows |
| Wokwi | ✅ (VS Code extension, GDB, CLI) | logic-level | – | – | MCU + parts | Paid for private projects and VS Code; ESP32, RP2040, AVR, STM32 |
| Tinkercad (3D + Circuits + Codeblocks) | basic | ✅ analog + logic | – | ✅ toy-level | Arduino | **Closest beginner product**, but stalled: ~9 libraries, no ESP32, weak editor |
| iCircuit 3D | ✅ runs real MicroPython/CircuitPython on emulated RP2040/RP2350 | ✅ | – | blocks | ✅ | Apple-only |
| SimulIDE | ✅ (AVR/PIC via simavr/gpsim) | real-time, approximate | – | – | ✅ | AGPL; self-described "not very accurate" |
| atopile, JITX, tscircuit | circuits **as code** | – | ✅ | tscircuit: 3D | – | Code-first EDA trend. tscircuit is React/TypeScript with KiCad import |
| PlatformIO / Arduino IDE 2 / ESP-IDF | ✅ | – | – | – | – | Arduino IDE 2 is built on Eclipse Theia |

**Our gap to fill:** Tinkercad's "everything in one place" simplicity, built on
**real engineering engines** (KiCad formats, OCCT, ngspice, MuJoCo, real MCU
emulators) with **real outputs** (Gerbers, STEP, firmware binaries). It is
local-first, open and scriptable.

## 2. The best simulation apps, by category

| Category | Best commercial | Best open | Our pick |
|---|---|---|---|
| SPICE | LTspice, PSpice, Multisim, Proteus | **ngspice** (KiCad's choice), Xyce, Qucs-S | **ngspice** (shared library plus WASM) |
| Real-time teaching circuits | Tinkercad, iCircuit | Falstad CircuitJS, SimulIDE | our own **fast MNA tier** (clean-room) |
| MCU / firmware | Wokwi, Proteus VSM | **Renode**, QEMU, simavr, **avr8js/rp2040js** | layered: avr8js → rp2040js → Renode → QEMU-ESP32 |
| Multibody / robotics | Simscape Multibody, Adams, Isaac Sim | **MuJoCo**, Chrono, Gazebo, Webots | **MuJoCo** |
| FEA / thermal / CFD | Ansys, COMSOL, SimScale | CalculiX, Elmer, OpenFOAM, FreeCAD FEM | later, as separate processes |
| System co-sim | Simulink, Dymola, Amesim | OpenModelica, FMI tools | our kernel plus **FMI 3.0** import |

## 3. What simulator games teach us

Simulator games aren't engineering tools, but they are the best in the world at
**instant, playful, stable real-time physics**, and that feel is what makes a
"Run" button fun.

| Game | Physics approach | Lesson for us |
|---|---|---|
| BeamNG.drive | **Soft-body node–beam**: nodes are mass points, beams are spring-dampers, collisions on nodes only. Lineage from open-source **Rigs of Rods** | Deformation is affordable when the model is simple and stepped at a high rate. Use it later for flexible parts (MuJoCo `flex`) |
| Kerbal Space Program | Unity/PhysX rigid parts joined by joints | **Joint chains wobble** (the "Kraken"). Mods reinforce joints, and the devs considered welding parts into blocks. **We weld rigidly mounted parts into one body and use reduced-coordinate joints (MuJoCo)** |
| Besiege, Poly Bridge, Algodoo | part-based building, instant play, visible stress | **UX:** build → press Play → watch it break → fix. Show stress and current with color, and make failure informative |

Design rules adopted:
1. **Two speeds of truth:** an *interactive* tier that is real-time,
   game-stable and approximate, and an *engineering* tier that is accurate,
   possibly slower than real time, and shows convergence warnings. The UI always
   shows which tier is active.
2. **Stability first in interactive mode:** fixed physics step with substeps,
   welded rigid groups, sleeping, and clamping. Flag numerical blow-ups
   instead of crashing.
3. **Make failure teach:** "Motor stalled: requested 0.8 N·m, available 0.3 N·m"
   is worth more than a silent wrong answer.

## 4. Standards and formats we adopt

| Domain | Standard | Use |
|---|---|---|
| Electronics source | KiCad native (`.kicad_sch`, `.kicad_pcb`, `.kicad_sym`, `.kicad_mod`, `.kicad_pro`) | source of truth |
| Manufacturing | Gerber X2/X3, Excellon, **IPC-2581**, **ODB++**, IPC-D-356, pick-and-place | through `kicad-cli` |
| ECAD↔MCAD | **STEP AP214/AP242**, **IDX** (ProSTEP EDMD; a KiCad proof of concept is aiming for v11) | STEP now, IDX later for Fusion/SolidWorks users |
| Mechanical | STEP, **3MF**/STL (3D printing), glTF 2.0 (viewing), USD (future scene interchange) | OCCT and three.js |
| Physics | **MJCF**/mjSpec (MuJoCo), URDF (ROS) export | robotics interop |
| Co-simulation | **FMI 3.0** (co-simulation, model exchange, scheduled execution; clocks, event mode, early return) and **SSP** (system structure) | third-party models (Modelica, Simulink) |
| Waveforms | VCD/FST, sigrok session | logic analyzer and debugging |
| Firmware | ELF/HEX/UF2, GDB remote serial protocol, DAP (VS Code debug), devicetree overlays (Zephyr) | build, debug and pin mapping |
| Extensions | Open VSX (VS Code extensions), KiCad IPC API plugins, KiCad remote parts provider | ecosystem |

## 5. License map of everything we touch

| Component | License | Where it may run (see PLAN §4.12) |
|---|---|---|
| Code-OSS / VSCodium, Monaco, Electron | MIT | in-process (our shell) |
| KiCad | GPL-3.0+ | separate process (companion and headless engine) |
| Blender | GPL (2.0+/3.0) | separate process (render and mesh companion) |
| OCCT 8 | LGPL-2.1 with OCCT exception | in-process (native or WASM) |
| ngspice | BSD-3 mostly, but numparam LGPL-2 and parts of XSPICE/ADMS GPL-2+ | sim service |
| MuJoCo | Apache-2.0 | in-process / sim service |
| avr8js, rp2040js, @wokwi/elements, eecircuit-engine | MIT | in-process |
| simavr | GPL-3.0+ | sim service |
| Renode | MIT (bundled Antmicro libraries Apache-2.0) | separate process (.NET) |
| QEMU | GPL-2.0-only | separate process only |
| three.js | MIT | in-process |
| Manifold | Apache-2.0 | in-process |
| freerouting | GPL-3.0 | separate process |
| CalculiX / Elmer / OpenFOAM | GPL | separate process |

*Not legal advice. Get a review before the first public release.*

## Sources

- KiCad 10.0.0 release: https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/
- KiCad IPC API docs: https://dev-docs.kicad.org/en/apis-and-binding/ipc-api · kicad-python: https://docs.kicad.org/kicad-python-main/
- Post-v10 development news (headless api-server): https://forum.kicad.info/t/post-v10-new-features-and-development-news
- IDX at FOSDEM 2026: https://fosdem.org/schedule/event/UHBKS8-ecad-mcad-collaboration-idx
- Fusion ECAD/MCAD: https://www.autodesk.com/products/fusion-360/blog/ecad-mcad-integration-in-autodesk-fusion-how-electronics-and-mechanical-design-work-together/
- iCircuit 3D: https://apps.apple.com/us/app/-/id1539977373 · Flux: https://electronicsforu.com/technology-trends/flux-eda-combines-pcb-design-and-ai
- Wokwi in ESP-IDF docs: https://docs.espressif.com/projects/esp-idf/en/stable/third-party-tools/wokwi.html · Chips API: https://docs.wokwi.com/chips-api/getting-started
- Tinkercad vs Wokwi: https://www.digikey.com/es/maker/blogs/2022/arduino-simulators-for-hobbyists-makers-and-classroom-environments
- SimulIDE: https://github.com/SimulIDE/SimulIDE
- Renode time framework: https://renode.readthedocs.io/en/latest/advanced/time_framework.html · Verilator co-sim: https://renode.readthedocs.io/en/latest/tutorials/co-simulating-custom-hdl.html
- MuJoCo changelog: https://mujoco.readthedocs.io/en/latest/changelog.html
- OCCT 8.0: https://dev.opencascade.org/content/open-cascade-technology-800-release
- FMI 3.0: https://fmi-standard.org/docs/3.0
- BeamNG physics: https://beamng.com/game/about/physics · JBeam: https://documentation.beamng.com/modding/vehicle/intro_jbeam/
- KSP joint wobble: https://wiki.kerbalspaceprogram.com/wiki/Wobbling · Kerbal Joint Reinforcement: https://github.com/linuxgurugamer/Kerbal-Joint-Reinforcement
- VS Code sandboxing / process model: https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox · Extension host: https://code.visualstudio.com/api/advanced-topics/extension-host · Agent host: https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture
- Positron (Code-OSS fork, Open VSX): https://github.com/posit-dev/positron
- Blender as a Python module: https://docs.blender.org/api/5.3/info_advanced_blender_as_bpy.html
- WebGPU on Linux (Chrome): https://developer.chrome.com/blog/new-in-webgpu-144 · https://developer.chrome.com/blog/new-in-webgpu-147-148
- tscircuit: https://github.com/tscircuit/tscircuit · atopile: https://hackaday.com/2024/02/06/atopile-wants-you-to-code-schematics
- GPL plug-in boundary discussion: https://safeguard.sh/resources/blog/gpl-plugins-one-program-or-two-programs
