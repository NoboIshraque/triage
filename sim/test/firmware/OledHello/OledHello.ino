// Adafruit's SSD1306 library on the Smart Fan's OLED (ROADMAP PA-4's test): a
// library installed with the Library Manager builds, runs in the simulator and
// draws on the simulated display.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(9600);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 failed");
    for (;;) {
    }
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("HELLO TRIAGE");
  display.setCursor(0, 16);
  display.println("ADAFRUIT GFX");
  display.display();
  Serial.println("drawn");
}

void loop() {
}
