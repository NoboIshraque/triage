# engines/arduino-avr: Arduino's AVR core

Arduino's AVR core (`upstream.json`: ArduinoCore-avr 1.8.8), unpatched: the Arduino
API (`cores/arduino`), the Uno and Nano pin variants and the Wire, SPI, EEPROM and
SoftwareSerial libraries. Triage's firmware build (`sim/src/firmware.ts`) compiles it
with the sketch when no Arduino IDE or arduino-cli install provides one; the app
ships it (`app/build.mjs engines`), so a machine needs only avr-gcc.

```sh
node engines/arduino-avr/fetch.mjs    # check out the pinned commit into upstream/
```
