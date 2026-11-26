// The SSD1306 128×64 OLED display on I²C (ROADMAP P3-3): its command set,
// three addressing modes and the frame buffer, plus the text drawn on it
// (scenarios check `oled(J3).text contains "HOT"`).
import { readPage } from './font.js';
import type { I2cDevice } from './i2c.js';

/** Parameter bytes that follow each command byte. */
function parameters(command: number): number {
  if (command === 0x20 || command === 0x81 || command === 0x8d || command === 0xa8) return 1;
  if (
    command === 0xd3 ||
    command === 0xd5 ||
    command === 0xd9 ||
    command === 0xda ||
    command === 0xdb
  )
    return 1;
  if (command === 0x21 || command === 0x22) return 2;
  if (command === 0x26 || command === 0x27) return 6; // horizontal scroll setup
  if (command === 0x29 || command === 0x2a) return 5;
  if (command === 0xa3) return 2;
  return 0;
}

export class Ssd1306 implements I2cDevice {
  readonly width = 128;
  readonly height = 64;
  /** Page-major frame buffer: byte = 8 vertical pixels, LSB at the top. */
  readonly buffer = new Uint8Array(128 * 8);
  on = false;
  contrast = 0x7f;
  inverted = false;
  /** Bumped on every change, so viewers can redraw only when needed. */
  version = 0;

  private mode = 2; // page addressing after reset
  private column = 0;
  private page = 0;
  private columnStart = 0;
  private columnEnd = 127;
  private pageStart = 0;
  private pageEnd = 7;

  private control: number | undefined;
  private command: number[] = [];

  constructor(readonly address = 0x3c) {}

  start(): void {
    // A new control byte; a command's parameters may still follow (the controller's
    // command parser keeps its state across transactions, and drivers rely on it).
    this.control = undefined;
  }

  stop(): void {
    this.control = undefined;
  }

  read(): number {
    return 0x00; // status: display on, not busy
  }

  write(byte: number): boolean {
    if (this.control === undefined) {
      this.control = byte;
      return true;
    }
    const data = (this.control & 0x40) !== 0;
    if (data) this.data(byte);
    else this.commandByte(byte);
    // Co bit set: one byte, then another control byte.
    if (this.control & 0x80) this.control = undefined;
    return true;
  }

  private commandByte(byte: number): void {
    this.command.push(byte);
    const first = this.command[0] ?? 0;
    if (this.command.length - 1 < parameters(first)) return;
    const [c, a = 0, b = 0] = this.command;
    this.command = [];
    switch (true) {
      case c === 0xae || c === 0xaf:
        this.on = c === 0xaf;
        break;
      case c === 0x81:
        this.contrast = a;
        break;
      case c === 0xa6 || c === 0xa7:
        this.inverted = c === 0xa7;
        break;
      case c === 0x20:
        this.mode = a & 0x03;
        break;
      case c === 0x21:
        this.columnStart = a & 0x7f;
        this.columnEnd = b & 0x7f;
        this.column = this.columnStart;
        break;
      case c === 0x22:
        this.pageStart = a & 0x07;
        this.pageEnd = b & 0x07;
        this.page = this.pageStart;
        break;
      case c !== undefined && c >= 0xb0 && c <= 0xb7:
        this.page = c & 0x07;
        break;
      case c !== undefined && c <= 0x0f:
        this.column = (this.column & 0xf0) | c;
        break;
      case c !== undefined && c >= 0x10 && c <= 0x1f:
        this.column = (this.column & 0x0f) | ((c & 0x0f) << 4);
        break;
      default:
        break; // timing and wiring commands don't change the picture
    }
    this.version += 1;
  }

  private data(byte: number): void {
    this.buffer[this.page * 128 + (this.column & 0x7f)] = byte;
    this.version += 1;
    if (this.mode === 2) {
      this.column = (this.column + 1) & 0x7f;
      return;
    }
    if (this.mode === 0) {
      if (this.column >= this.columnEnd) {
        this.column = this.columnStart;
        this.page = this.page >= this.pageEnd ? this.pageStart : this.page + 1;
      } else this.column += 1;
    } else if (this.page >= this.pageEnd) {
      this.page = this.pageStart;
      this.column = this.column >= this.columnEnd ? this.columnStart : this.column + 1;
    } else this.page += 1;
  }

  /** A pixel (x right, y down). */
  pixel(x: number, y: number): boolean {
    return ((this.buffer[(y >> 3) * 128 + x] ?? 0) & (1 << (y & 7))) !== 0;
  }

  /** The text on the display, one line per page with text. */
  get text(): string {
    if (!this.on) return '';
    const lines: string[] = [];
    for (let page = 0; page < 8; page++) {
      const line = readPage(this.buffer.subarray(page * 128, page * 128 + 128)).trimEnd();
      if (line !== '') lines.push(line);
    }
    return lines.join('\n');
  }
}
