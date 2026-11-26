# Smart Fan (example project)

The walkthrough device of [PLAN §3](../../docs/PLAN.md): a thermistor reads the
room temperature, an Arduino Uno drives a fan through a MOSFET with PWM, and the
fan sits in a printed enclosure.

| Folder | Domain | Filled in by |
|---|---|---|
| `firmware/` | Code | the firmware: the fan curve, the Mode button, the OLED (`src/oled.cpp`) |
| `electronics/` | Electronics | the KiCad project (schematic and board, Arduino Uno shield) |
| `mechanical/` | Mechanical | the fan's rotor (`fan.FCStd`, P2-2) and the enclosure from the board (P2-4) |
| `simulation/` | Simulation | `parts.toml` (the fan on J1, the OLED on J3, the rotor), `environment.toml`, a saved scope and five scenarios (P3) |
| `.triage/` | (Triage) | `links.json`, the link graph Triage writes from the schematic (the simulation reads it) |

Open this folder in Triage: the Triage sidebar shows the four domains. The Sim
tab runs it; `node cli/dist/bin.js test examples/smart-fan` runs its scenarios.
