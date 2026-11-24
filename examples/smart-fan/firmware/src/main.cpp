// Smart Fan firmware (Arduino Uno). P1-5 generates board_pins.h from the
// schematic; until then the pins are written here.
#include <Arduino.h>

constexpr uint8_t THERMISTOR_PIN = A0;
constexpr uint8_t FAN_PWM_PIN = 9;

void setup() {
  pinMode(FAN_PWM_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  const int reading = analogRead(THERMISTOR_PIN);
  // Warmer room -> lower NTC resistance -> higher reading -> faster fan.
  const int duty = constrain(map(reading, 400, 700, 0, 255), 0, 255);
  analogWrite(FAN_PWM_PIN, duty);
  Serial.print("reading=");
  Serial.print(reading);
  Serial.print(" duty=");
  Serial.println(duty);
  delay(500);
}
