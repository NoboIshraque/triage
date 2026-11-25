// Smart Fan firmware (Arduino Uno). The pins come from the schematic:
// Triage writes ../generated/board_pins.h from electronics/smart-fan.kicad_sch
// (ROADMAP P1-5), so renaming a net there renames the constant here.
#include <Arduino.h>

#include "../generated/board_pins.h"

void setup() {
  pinMode(FAN_PWM, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  Serial.begin(115200);
}

void loop() {
  const int reading = analogRead(TEMP_SENSE);
  // Warmer room -> lower NTC resistance -> higher reading -> faster fan.
  const int duty = constrain(map(reading, 400, 700, 0, 255), 0, 255);
  analogWrite(FAN_PWM, duty);
  Serial.print("reading=");
  Serial.print(reading);
  Serial.print(" duty=");
  Serial.println(duty);
  delay(500);
}
