# engines/: native engine processes

Hidden engine processes behind Triage's tabs ([ADR 0002](../docs/adr/0002-absorb-engines-headless.md)).
Each fork keeps the layout from GUIDELINES §6: `upstream/` (a pinned release,
untouched), `patches/` (numbered changes to upstream files) and a `triage/`
folder for Triage-only code.

| Folder | What | Work package |
|---|---|---|
| [`hello/`](hello/) | The smallest Triage engine process, built by the root `CMakeLists.txt` | P0-1 (seed), P0-4 (connection pattern) |
| [`eda/`](eda/) | KiCad fork: headless engine host, Stream GAL, remote tools, API | P1-1 … P1-6 |
| [`cad/`](cad/) | FreeCAD fork: App layer, RPC server | P2-1, P2-2 |
| [`mujoco/`](mujoco/) | MuJoCo 4.0.1, pinned and built from source (not a fork) for the mechanics unit | P3-4 |
| [`arduino-avr/`](arduino-avr/) | Arduino's AVR core 1.8.8, pinned (not a fork), compiled with firmware and shipped in the app | P3-2 |
| [`qemu-esp32/`](qemu-esp32/) | Espressif QEMU fork plus Triage peripheral models | P4-1 |
| [`render/`](render/) | Blender scripts and RPC | P8-1 |

Build Triage's own native code (not the forks) with CMake presets:

```sh
cmake --workflow --preset dev   # configure, build and test (Debug)
cmake --workflow --preset ci    # what CI runs (Release, warnings are errors)
```

On Windows, run these from a Visual Studio developer shell (MSVC + Ninja).
