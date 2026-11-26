// Intel HEX (what avr-objcopy writes for firmware.hex) into flash bytes.

/** Parses Intel HEX into a flash image of `size` bytes (0xFF where unwritten). */
export function parseHex(text: string, size = 0x8000): Uint8Array {
  const flash = new Uint8Array(size).fill(0xff);
  let base = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith(':')) throw new Error(`line ${index + 1}: not Intel HEX`);
    const bytes = Uint8Array.from(line.slice(1).match(/../g) ?? [], (b) => parseInt(b, 16));
    const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== 0) throw new Error(`line ${index + 1}: bad checksum`);
    const count = bytes[0] ?? 0;
    const address = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + count);
    if (type === 0) {
      const at = base + address;
      if (at + count > size)
        throw new Error(`line ${index + 1}: data beyond ${size} bytes of flash`);
      flash.set(data, at);
    } else if (type === 1) {
      break;
    } else if (type === 2) {
      base = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 4;
    } else if (type === 4) {
      base = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 16;
    }
  }
  return flash;
}

/** A flash image as the AVR's 16-bit program words. */
export function programWords(flash: Uint8Array): Uint16Array {
  const words = new Uint16Array(flash.length / 2);
  for (let i = 0; i < words.length; i++)
    words[i] = (flash[2 * i] ?? 0) | ((flash[2 * i + 1] ?? 0) << 8);
  return words;
}

/** Writes bytes as Intel HEX (16 bytes per record). */
export function toHex(bytes: Uint8Array): string {
  const lines: string[] = [];
  const record = (address: number, type: number, data: Uint8Array) => {
    const all = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
    const sum = (0x100 - (all.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    lines.push(
      `:${[...all, sum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`,
    );
  };
  for (let at = 0; at < bytes.length; at += 16) record(at, 0, bytes.subarray(at, at + 16));
  record(0, 1, new Uint8Array());
  return `${lines.join('\n')}\n`;
}
