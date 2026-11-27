// An emulated Arduino Uno with its real bootloader (ROADMAP PA-3): Optiboot from the
// shipped Arduino AVR core at the top of flash, the Uno's fuses (BOOTRST: every
// reset starts the bootloader), self-programming (SPM) and the watchdog, so
// `arduino-cli upload` (avrdude's "arduino" protocol) programs it exactly as it
// programs a real board. Its serial port is a TCP socket: a connection is the
// USB adapter's DTR pulse (the board resets into the bootloader), bytes are the
// UART's. avrdude reaches it as `net:127.0.0.1:<port>`; on Linux, socat turns it
// into a virtual serial port (a pty) that avrdude and the serial monitor open like
// /dev/ttyACM0. CI tests Upload and the Serial Monitor without a board this way.
import { createServer, type Server, type Socket } from 'node:net';
import {
  AVRClock,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  AVRWatchdog,
  CPU,
  clockConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
  watchdogConfig,
} from 'avr8js';
import { avrInstructionFast } from './generated/avr-decoder.js';
import { parseHex, programWords } from './hex.js';

const SPM = 0x95e8;
/** ATmega328P: SPMCSR's data address, its page size in words, MCUSR's address. */
const SPMCSR = 0x57;
const PAGE_WORDS = 64;
const MCUSR = 0x54;
const EXTRF = 0x02;
const PORF = 0x01;
const UCSR0A = 0xc0;
const RXC0 = 0x80;

export interface EmulatedBoardOptions {
  /** The bootloader (Optiboot's Intel HEX: optiboot_atmega328.hex). */
  readonly bootloaderHex: string;
  /** A program already in flash, as if uploaded before. */
  readonly appHex?: string;
  readonly frequency?: number;
  /** Where the bootloader starts, in words (the Uno's fuses: 0x3F00, 512 bytes). */
  readonly bootStartWord?: number;
}

export class EmulatedBoard {
  readonly cpu: CPU;
  readonly usart: AVRUSART;
  readonly portB: AVRIOPort;
  private readonly frequency: number;
  private readonly bootStart: number;
  private readonly pageBuffer = new Uint16Array(PAGE_WORDS).fill(0xffff);
  private readonly rx: number[] = [];
  private readonly resettable: { reset(): void }[] = [];
  private timer: ReturnType<typeof setImmediate> | undefined;
  private wallStart = 0;
  private cycleStart = 0;
  /** Bytes the board sent, for whoever listens (the TCP bridge). */
  onSerial: ((byte: number) => void) | undefined;
  /** Pages written by the bootloader (tests). */
  pagesWritten = 0;

  constructor(options: EmulatedBoardOptions) {
    this.frequency = options.frequency ?? 16_000_000;
    this.bootStart = options.bootStartWord ?? 0x3f00;
    // Unprogrammed flash reads 0xFF.
    const flash = options.appHex ? parseHex(options.appHex) : new Uint8Array(0x8000).fill(0xff);
    const boot = parseHex(options.bootloaderHex);
    flash.set(boot.subarray(this.bootStart * 2), this.bootStart * 2);
    this.cpu = new CPU(programWords(flash), 2048);
    const clock = new AVRClock(this.cpu, this.frequency, clockConfig);
    const timers = [timer0Config, timer1Config, timer2Config].map((c) => new AVRTimer(this.cpu, c));
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    new AVRIOPort(this.cpu, portCConfig);
    new AVRIOPort(this.cpu, portDConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, this.frequency);
    new AVRWatchdog(this.cpu, watchdogConfig, clock);
    this.resettable.push(this.usart, ...timers.filter(hasReset));
    this.usart.onByteTransmit = (byte) => this.onSerial?.(byte);
    this.usart.onRxComplete = () => {
      this.feed();
    };
    // The watchdog's reset (avr8js starts at 0): with BOOTRST, the bootloader starts.
    const reset = this.cpu.reset.bind(this.cpu);
    this.cpu.reset = () => {
      const mcusr = this.cpu.data[MCUSR] ?? 0;
      reset();
      this.clearIo();
      this.cpu.data[MCUSR] = mcusr;
      this.cpu.pc = this.bootStart;
    };
    this.reset(PORF);
  }

  /** A reset from outside (power on, the reset pin): MCUSR says which. */
  reset(cause = EXTRF): void {
    this.cpu.reset();
    this.cpu.data[MCUSR] = cause;
    this.rx.length = 0;
  }

  private clearIo(): void {
    // Registers, I/O and SRAM start at 0; the peripherals' own state too.
    this.cpu.data.fill(0);
    this.cpu.SP = this.cpu.data.length - 1;
    for (const peripheral of this.resettable) peripheral.reset();
  }

  /** Flash as bytes (what was uploaded). */
  get flash(): Uint8Array {
    const words = this.cpu.progMem;
    const bytes = new Uint8Array(words.length * 2);
    for (let i = 0; i < words.length; i++) {
      bytes[2 * i] = (words[i] ?? 0) & 0xff;
      bytes[2 * i + 1] = (words[i] ?? 0) >> 8;
    }
    return bytes;
  }

  /** Bytes from the serial line to the board's RX pin. */
  receive(bytes: Iterable<number>): void {
    this.rx.push(...bytes);
    this.feed();
  }

  /**
   * The next byte goes in once the firmware has read the last one (RXC0 clear): a
   * lossless link. (A real UART overruns while Optiboot blinks its LED; avrdude
   * then retries. Here the bytes simply wait.)
   */
  private feed(): void {
    const received = ((this.cpu.data[UCSR0A] ?? 0) & RXC0) !== 0;
    if (this.rx.length > 0 && !this.usart.rxBusy && !received) {
      const byte = this.rx[0];
      if (byte !== undefined && this.usart.writeByte(byte)) this.rx.shift();
    }
  }

  /** Runs `cycles` CPU cycles. */
  runCycles(cycles: number): void {
    const cpu = this.cpu;
    const until = cpu.cycles + cycles;
    while (cpu.cycles < until) {
      if (cpu.progMem[cpu.pc] === SPM) {
        this.spm();
        cpu.pc = (cpu.pc + 1) % cpu.progMem.length;
        cpu.cycles++;
      } else {
        avrInstructionFast(cpu);
      }
      cpu.tick();
      if (this.rx.length > 0) this.feed();
    }
  }

  /** Self-programming: fill the page buffer, erase a page, write it (Optiboot's steps). */
  private spm(): void {
    const cpu = this.cpu;
    const control = cpu.data[SPMCSR] ?? 0;
    const z = ((cpu.data[31] ?? 0) << 8) | (cpu.data[30] ?? 0);
    const word = (z >> 1) & 0x3fff;
    const page = word & ~(PAGE_WORDS - 1);
    switch (control & 0x1f) {
      case 0x01: // SPMEN: R1:R0 into the page buffer
        this.pageBuffer[word & (PAGE_WORDS - 1)] = (cpu.data[0] ?? 0) | ((cpu.data[1] ?? 0) << 8);
        break;
      case 0x03: // PGERS
        if (page < this.bootStart) cpu.progMem.fill(0xffff, page, page + PAGE_WORDS);
        break;
      case 0x05: // PGWRT
        if (page < this.bootStart) {
          cpu.progMem.set(this.pageBuffer, page);
          this.pagesWritten++;
        }
        this.pageBuffer.fill(0xffff);
        break;
      default: // RWWSRE, BLBSET, SIGRD: nothing to do here
        break;
    }
    // The operation is done at once: SPMEN reads 0 (boot_spm_busy_wait returns).
    cpu.data[SPMCSR] = control & ~0x1f;
  }

  /** Runs at the wall clock's pace until stopped. */
  start(): void {
    if (this.timer) return;
    this.wallStart = performance.now();
    this.cycleStart = this.cpu.cycles;
    const step = () => {
      const due =
        this.cycleStart +
        Math.floor(((performance.now() - this.wallStart) / 1000) * this.frequency);
      // At most 20 ms of emulation per turn, so the event loop stays responsive.
      const cycles = Math.min(due - this.cpu.cycles, this.frequency / 50);
      if (cycles > 0) this.runCycles(cycles);
      this.timer = setImmediate(step);
    };
    this.timer = setImmediate(step);
  }

  stop(): void {
    if (this.timer) clearImmediate(this.timer);
    this.timer = undefined;
  }
}

function hasReset(value: unknown): value is { reset(): void } {
  return typeof (value as { reset?: unknown }).reset === 'function';
}

/**
 * Serves an emulated board's serial port on 127.0.0.1:`port` (0: any free port).
 * Each connection resets the board into its bootloader, as opening a real Uno's
 * port does (DTR); one connection at a time.
 */
export function serveBoard(
  board: EmulatedBoard,
  port = 0,
): Promise<{ port: number; close(): Promise<void>; server: Server }> {
  let current: Socket | undefined;
  board.onSerial = (byte) => current?.write(Uint8Array.of(byte));
  const server = createServer((socket) => {
    current?.destroy();
    current = socket;
    socket.setNoDelay(true);
    board.reset(EXTRF);
    socket.on('data', (data: Buffer) => {
      board.receive(data);
    });
    socket.on('close', () => {
      if (current === socket) current = undefined;
    });
    socket.on('error', () => {
      socket.destroy();
    });
  });
  board.start();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: bound,
        server,
        close: () =>
          new Promise<void>((done) => {
            board.stop();
            current?.destroy();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
