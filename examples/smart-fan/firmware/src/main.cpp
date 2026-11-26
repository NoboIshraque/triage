// Smart Fan firmware (Arduino Uno). The pins come from the schematic:
// Triage writes ../generated/board_pins.h from electronics/smart-fan.kicad_sch
// (ROADMAP P1-5), so renaming a net there renames the constant here.
//
// The fan follows the room's temperature: off below 25 C, 80% at 35 C, full at
// 37.5 C. The Mode button cycles Auto -> Max -> Off. The OLED shows the
// temperature, the fan's duty and the mode, and "HOT" from 38 C.
#include "../generated/board_pins.h"
#include "oled.h"

#include <Arduino.h>
#include <math.h>

// The thermistor divider: +5 V - NTC (10 k at 25 C, beta 3950) - A0 - 10 k - GND.
constexpr float SERIES_OHMS = 10000.0f;
constexpr float NTC_R25 = 10000.0f;
constexpr float NTC_BETA = 3950.0f;

// The fan curve.
constexpr float FAN_START_C = 25.0f;
constexpr float FAN_FULL_C = 37.5f;
constexpr float HOT_C = 38.0f;

enum Mode : uint8_t { AUTO, MAX, OFF };
const char *const MODE_NAMES[] = {"AUTO", "MAX", "OFF"};

Mode mode = AUTO;
bool displayOk = false;
bool lastButton = HIGH;
unsigned long lastChange = 0;
unsigned long lastUpdate = 0;

// Room temperature from an ADC reading of the divider (10 bits, 5 V reference).
float temperatureC(int reading) {
  if (reading <= 0)
    return -40.0f;
  if (reading >= 1023)
    return 125.0f;
  const float ntc = SERIES_OHMS * (1024.0f / reading - 1.0f);
  const float kelvin = 1.0f / (1.0f / 298.15f + log(ntc / NTC_R25) / NTC_BETA);
  return kelvin - 273.15f;
}

// Fan duty (0-255) for a temperature in Auto mode.
uint8_t dutyFor(float celsius) {
  const float f = (celsius - FAN_START_C) / (FAN_FULL_C - FAN_START_C);
  if (f <= 0.0f)
    return 0;
  if (f >= 1.0f)
    return 255;
  return static_cast<uint8_t>(f * 255.0f + 0.5f);
}

void setup() {
  pinMode(FAN_PWM, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  Serial.begin(115200);
  displayOk = oled::begin();
  Serial.println(displayOk ? F("Smart Fan ready") : F("Smart Fan ready (no display)"));
}

void loop() {
  const unsigned long now = millis();

  // The Mode button (to ground, with the pull-up): debounced press.
  const bool button = digitalRead(BUTTON);
  if (button != lastButton && now - lastChange > 30) {
    lastChange = now;
    lastButton = button;
    if (button == LOW)
      mode = static_cast<Mode>((mode + 1) % 3);
  }

  if (now - lastUpdate < 100)
    return;
  lastUpdate = now;

  const int reading = analogRead(TEMP_SENSE);
  const float celsius = temperatureC(reading);
  const uint8_t duty = mode == MAX ? 255 : mode == OFF ? 0 : dutyFor(celsius);
  analogWrite(FAN_PWM, duty);
  const int percent = (duty * 100 + 127) / 255;

  char line[22];
  char number[8];
  dtostrf(celsius, 4, 1, number);
  snprintf(line, sizeof line, "%sC %d%%", number, percent);
  if (displayOk) {
    oled::text(0, 0, line, 21);
    oled::text(0, 2, MODE_NAMES[mode], 21);
    oled::text(0, 4, celsius >= HOT_C ? "HOT" : "", 21);
  }
  Serial.print(F("t="));
  Serial.print(number);
  Serial.print(F(" reading="));
  Serial.print(reading);
  Serial.print(F(" duty="));
  Serial.print(percent);
  Serial.print(F("% mode="));
  Serial.println(MODE_NAMES[mode]);
}
