// The SSD1306 model and reading text off it (ROADMAP P3-3).
import { describe, expect, it } from 'vitest';
import { FONT_5X7, FONT_FIRST, readPage } from '../src/font.js';
import { Ssd1306 } from '../src/ssd1306.js';

function send(display: Ssd1306, control: number, bytes: number[]): void {
  display.start();
  display.write(control);
  for (const b of bytes) display.write(b);
  display.stop();
}

function glyphs(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++)
    out.push(...(FONT_5X7[text.charCodeAt(i) - FONT_FIRST] ?? []), 0);
  return out;
}

describe('SSD1306', () => {
  it('every glyph but the space is different', () => {
    const keys = new Set(FONT_5X7.slice(1).map((g) => g.join(',')));
    expect(keys.size).toBe(94);
  });

  it('draws in horizontal addressing mode and reads back the text', () => {
    const d = new Ssd1306();
    send(d, 0x00, [0xae, 0x20, 0x00, 0x21, 0, 127, 0x22, 0, 7, 0xaf]);
    expect(d.on).toBe(true);
    send(d, 0x40, glyphs('35.0C 80%'));
    send(d, 0x00, [0x21, 0, 127, 0x22, 4, 7]);
    send(d, 0x40, glyphs('HOT'));
    expect(d.text).toBe('35.0C 80%\nHOT');
    // "3": its first column, 0x21, lights rows 0 and 5.
    expect(d.pixel(0, 0)).toBe(true);
    expect(d.pixel(0, 1)).toBe(false);
    expect(d.pixel(0, 5)).toBe(true);
  });

  it('supports page addressing and single commands with the Co bit', () => {
    const d = new Ssd1306();
    send(d, 0x80, [0xaf]);
    expect(d.on).toBe(true);
    send(d, 0x00, [0xb2, 0x00, 0x10]); // page 2, column 0
    send(d, 0x40, glyphs('OK'));
    expect(d.text).toBe('OK');
    // Overwritten with spaces: gone.
    send(d, 0x00, [0xb2, 0x00, 0x10]);
    send(d, 0x40, glyphs('  '));
    expect(d.text).toBe('');
  });

  it('takes a command\'s parameters from later transactions, as drivers send them', () => {
    const d = new Ssd1306();
    for (const byte of [0x20, 0x00, 0x21, 0, 127, 0x22, 3, 7, 0xaf]) send(d, 0x00, [byte]);
    send(d, 0x40, glyphs('MAX'));
    expect(d.text).toBe('MAX');
    expect(d.buffer[3 * 128]).toBe(FONT_5X7['M'.charCodeAt(0) - FONT_FIRST]?.[0]);
  });

  it('reads spaced words', () => {
    const page = new Uint8Array(128);
    page.set(glyphs('A  B'));
    expect(readPage(page)).toBe('A  B');
  });
});
