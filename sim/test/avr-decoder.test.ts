// The table-driven decoder (src/generated/avr-decoder.ts) does exactly what
// avr8js's own decoder does, for every one of the 65,536 opcodes.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { CPU, avrInstruction } from 'avr8js';
import { describe, expect, it } from 'vitest';
import { avrInstructionFast } from '../src/generated/avr-decoder.js';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** A CPU with a random program, registers and I/O, stack inside RAM. */
function randomCpu(seed: number): { cpu: CPU; data: Uint8Array } {
  const random = seeded(seed);
  const program = new Uint16Array(0x4000);
  for (let i = 0; i < program.length; i++) program[i] = random() & 0xffff;
  const cpu = new CPU(program, 2048);
  for (let i = 0; i < 0x100; i++) cpu.data[i] = random() & 0xff;
  cpu.data[93] = 0xf0; // SP: inside RAM
  cpu.data[94] = 0x07;
  return { cpu, data: cpu.data.slice() };
}

describe('table-driven AVR decoder', () => {
  it('matches avr8js on every opcode', () => {
    const differences: string[] = [];
    for (const seed of [1, 2]) {
      const a = randomCpu(seed);
      const b = randomCpu(seed);
      for (let opcode = 0; opcode < 65536; opcode++) {
        for (const { cpu, data } of [a, b]) {
          cpu.data.set(data);
          cpu.progMem[0x100] = opcode;
          cpu.pc = 0x100;
          cpu.cycles = 0;
        }
        avrInstruction(a.cpu);
        avrInstructionFast(b.cpu);
        const same =
          a.cpu.pc === b.cpu.pc &&
          a.cpu.cycles === b.cpu.cycles &&
          a.cpu.data.every((v, i) => v === b.cpu.data[i]);
        if (!same) differences.push(opcode.toString(16));
      }
    }
    expect(differences).toEqual([]);
  });

  it('is generated from the installed avr8js', () => {
    const script = path.join(import.meta.dirname, '..', 'scripts', 'avr-decoder.mjs');
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' }),
    ).not.toThrow();
  });
});
