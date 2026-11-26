# Smart Fan electronics (KiCad 10)

An Arduino Uno shield (PLAN §3 step 2): an NTC thermistor divider on A0
(`TEMP_SENSE`), a logic-level MOSFET with a flyback diode driving a 12 V fan from
D9 (`FAN_PWM`), an SSD1306 OLED header on I²C (`I2C_SDA`, `I2C_SCL`), a button on
D2 (`BUTTON`) and a 12 V barrel jack.

- `smart-fan.kicad_sch`, `smart-fan.kicad_pcb`, `smart-fan.kicad_pro`: a normal
  KiCad project; it opens in stock KiCad 10. ERC and DRC report no errors; the
  board is placed but not routed yet (simple tracks arrive in P3).
- `libraries/smart_fan.*`: the symbols and footprints it uses, copied from KiCad
  10.0.8's official libraries, so the project needs no libraries installed.
- The firmware's pin constants (`../firmware/generated/board_pins.h`) are
  generated from this schematic by Triage.

`scripts/examples/smart-fan-kicad.mjs` generated these files (KiCad's own
`kicad-cli` wrote the final versions); edit them in Triage or KiCad from now on.
