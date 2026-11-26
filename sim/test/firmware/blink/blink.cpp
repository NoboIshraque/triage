// Arduino's Blink (ROADMAP P3-2 done-when): the on-board LED pin, D13, on for
// 500 ms and off for 500 ms.
#include <Arduino.h>

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
