# Smart Fan: mechanical (FreeCAD)

| File | What | Made by |
|---|---|---|
| `fan.FCStd` | the fan's rotor: a PartDesign body with a hub, a pitched blade, a polar pattern of five and a 2 mm shaft hole; its sizes are named sketch constraints (`HubRadius`, `BladeLength`, `BladeWidth` …) | `scripts/examples/smart_fan_freecad.py`, run through the CAD engine's own FreeCAD (`node scripts/examples/smart-fan-freecad.mjs`) |

The enclosure generated from the board arrives with ROADMAP P2-4. Every document
opens in stock FreeCAD 1.1; Triage's CAD engine opens and recomputes each one over
JSON-RPC in `app/engine-tests/src/cadEngine.test.ts`.
