// A small SSD1306 128x64 OLED driver on I2C (Wire): no libraries to install.
// Text uses a 5x7 font, 21 characters by 8 lines.
#pragma once

#include <stdint.h>

namespace oled {

// Sets the display up (address 0x3C) and clears it. Returns false if nothing answers.
bool begin(uint8_t address = 0x3C);
// Clears the whole display.
void clear();
// Writes text at a character column (0-20) and line (0-7), padding it to `width`
// characters with spaces so old text is overwritten.
void text(uint8_t column, uint8_t line, const char *s, uint8_t width = 0);

} // namespace oled
