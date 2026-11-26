// Serial echo (ROADMAP P3-2 done-when): sends back every byte it receives, and
// a greeting at start.
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  Serial.println("echo ready");
}

void loop() {
  while (Serial.available() > 0)
    Serial.write(Serial.read());
}
