// The AVR unit (ROADMAP P3-2, PLAN §4.7): an ATmega328P (Arduino Uno, Nano) in
// avr8js, run as the Rust kernel's host. Each quantum it runs up to the grant's
// end, or stops at its first output event (a pin's drive changes) or when its
// ADC starts a conversion (sync on demand: the kernel advances the circuit to
// that instant first). Pins, the ADC, the USART (serial monitor), the TWI (I²C
// devices at transaction level) and the SPI port are wired.
import {
  ADCMuxInputType,
  AVRADC,
  AVRIOPort,
  AVRSPI,
  AVRTimer,
  AVRTWI,
  AVRUSART,
  CPU,
  PinState,
  adcConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
} from 'avr8js';
import type { ADCMuxInput } from 'avr8js';
import { avrInstructionFast } from './generated/avr-decoder.js';
import { Logic } from './addon.js';
import type { AvrPin, BoardProfile } from './boards.js';
import { I2cBus, type I2cDevice } from './i2c.js';

/** A pin of the host, as the kernel's DeviceInfo lists it. */
export interface HostPin {
  readonly name: string;
  readonly net: string;
  readonly analog: boolean;
  readonly drive: number;
  readonly voltage: number;
}

/** One byte on the serial port, with its virtual time. */
export interface SerialByte {
  readonly t: number;
  readonly byte: number;
}

interface WatchedPin {
  readonly host: HostPin;
  readonly avr: AvrPin;
  readonly port: AVRIOPort;
  drive: number;
  /** The logic level the pin reads (with hysteresis). */
  level: boolean;
}

/** Thresholds of an ATmega328P input at 5 V: high above 0.6 Vcc, low below 0.3 Vcc. */
const VIH = 3.0;
const VIL = 1.5;

function driveOf(state: PinState): number {
  switch (state) {
    case PinState.Low:
      return Logic.Low;
    case PinState.High:
      return Logic.High;
    case PinState.InputPullUp:
      return Logic.WeakHigh;
    default:
      return Logic.Z;
  }
}

export class AvrUnit {
  readonly cpu: CPU;
  readonly usart: AVRUSART;
  readonly adc: AVRADC;
  readonly twi: AVRTWI;
  readonly spi: AVRSPI;
  readonly i2c: I2cBus;
  /** Serial output, in order. */
  readonly serial: SerialByte[] = [];
  /** Called for every byte the firmware sends. */
  onSerial: ((byte: SerialByte) => void) | undefined;

  private readonly cyclePs: number;
  private readonly ports: Record<'B' | 'C' | 'D', AVRIOPort>;
  private readonly pins: WatchedPin[] = [];
  private readonly byVoltage = new Map<number, WatchedPin[]>();
  private readonly rx: number[] = [];
  private events: number[] = [];
  private stop = false;
  private adcPending: ADCMuxInput | undefined;
  private untilPs = 0;
  /** Instructions executed (for benchmarks). */
  instructions = 0;

  constructor(
    program: Uint16Array,
    readonly profile: BoardProfile,
    hostPins: readonly HostPin[],
    devices: readonly I2cDevice[] = [],
  ) {
    this.cpu = new CPU(program, 2048);
    this.cyclePs = 1e12 / profile.frequency;
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    this.ports = {
      B: new AVRIOPort(this.cpu, portBConfig),
      C: new AVRIOPort(this.cpu, portCConfig),
      D: new AVRIOPort(this.cpu, portDConfig),
    };
    this.usart = new AVRUSART(this.cpu, usart0Config, profile.frequency);
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.twi = new AVRTWI(this.cpu, twiConfig, profile.frequency);
    this.spi = new AVRSPI(this.cpu, spiConfig, profile.frequency);
    this.i2c = new I2cBus(this.twi, devices);
    this.twi.eventHandler = this.i2c;

    this.usart.onByteTransmit = (byte) => {
      const entry = { t: this.timePs, byte };
      this.serial.push(entry);
      this.onSerial?.(entry);
    };
    this.usart.onRxComplete = () => {
      this.feedSerial();
    };

    // Sync on demand: stop at the start of each conversion; finish it once the
    // kernel has advanced the circuit to now and sent the pin voltages.
    this.adc.onADCRead = (input) => {
      this.adcPending = input;
      this.stop = true;
    };

    for (const host of hostPins) {
      const avr = profile.pins[host.name];
      if (!avr) continue;
      const port = this.ports[avr.port];
      const pin: WatchedPin = { host, avr, port, drive: Logic.Z, level: false };
      this.pins.push(pin);
      const list = this.byVoltage.get(host.voltage) ?? [];
      list.push(pin);
      this.byVoltage.set(host.voltage, list);
    }
    for (const port of Object.values(this.ports)) {
      const watched = this.pins.filter((p) => p.port === port && !p.avr.adcOnly);
      if (watched.length === 0) continue;
      port.addListener(() => {
        for (const pin of watched) {
          const drive = driveOf(port.pinState(pin.avr.bit));
          if (drive !== pin.drive) {
            pin.drive = drive;
            // An output event: report it and stop after this instruction.
            this.events.push(Math.min(this.timePs, this.untilPs), pin.host.drive, 0, drive);
            this.stop = true;
          }
        }
      });
    }
  }

  /** Virtual time of the CPU, ps. */
  get timePs(): number {
    return this.cpu.cycles * this.cyclePs;
  }

  /**
   * Runs up to `untilPs`, or to the first output event or ADC conversion start.
   * Returns the time reached and the drive events as (time, signal, kind, level) quads.
   */
  run(untilPs: number): { reached: number; events: Float64Array } {
    this.untilPs = untilPs;
    this.events = [];
    this.stop = false;
    this.finishAdc();
    this.feedSerial();
    // Every instruction that starts before `untilPs` (a grant shorter than a cycle
    // still runs the next one, or time would not advance).
    const untilCycles = Math.ceil(untilPs / this.cyclePs);
    const cpu = this.cpu;
    let count = 0;
    // `stop` is set by the port listeners and the ADC during an instruction.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (cpu.cycles < untilCycles && !this.stop) {
      avrInstructionFast(cpu);
      cpu.tick();
      count++;
    }
    this.instructions += count;
    const reached = Math.min(this.timePs, untilPs);
    return { reached, events: Float64Array.from(this.events) };
  }

  /** Applies the inputs the kernel says changed: `[now, n, (signal, kind, value) × n]`. */
  apply(unblock: Float64Array): void {
    const n = unblock[1] ?? 0;
    for (let i = 0; i < n; i++) {
      const signal = unblock[2 + 3 * i] ?? -1;
      const volts = unblock[4 + 3 * i] ?? 0;
      for (const pin of this.byVoltage.get(signal) ?? []) this.setVoltage(pin, volts);
    }
  }

  private setVoltage(pin: WatchedPin, volts: number): void {
    if (pin.avr.adc !== undefined) this.adc.channelValues[pin.avr.adc] = volts;
    if (pin.avr.adcOnly) return;
    const level = pin.level ? volts > VIL : volts >= VIH;
    if (level !== pin.level) {
      pin.level = level;
      pin.port.setPin(pin.avr.bit, level);
    }
  }

  private finishAdc(): void {
    const input = this.adcPending;
    if (!input) return;
    this.adcPending = undefined;
    // What avr8js's own onADCRead does, with the voltages synced to now.
    let voltage = 0;
    switch (input.type) {
      case ADCMuxInputType.Constant:
        voltage = input.voltage;
        break;
      case ADCMuxInputType.SingleEnded:
        voltage = (this.adc.channelValues[input.channel] as number | undefined) ?? 0;
        break;
      case ADCMuxInputType.Differential:
        voltage =
          input.gain *
          (((this.adc.channelValues[input.positiveChannel] as number | undefined) ?? 0) -
            ((this.adc.channelValues[input.negativeChannel] as number | undefined) ?? 0));
        break;
      case ADCMuxInputType.Temperature:
        voltage = 0.378125;
        break;
    }
    const raw = Math.min(
      Math.max(Math.floor((voltage / this.adc.referenceVoltage) * 1024), 0),
      1023,
    );
    this.cpu.addClockEvent(() => {
      this.adc.completeADCRead(raw);
    }, this.adc.sampleCycles);
  }

  /** Queues bytes for the firmware's serial input (the serial monitor's send). */
  sendSerial(bytes: Iterable<number>): void {
    this.rx.push(...bytes);
    this.feedSerial();
  }

  private feedSerial(): void {
    if (this.rx.length > 0 && !this.usart.rxBusy) {
      const byte = this.rx.shift();
      if (byte !== undefined) this.usart.writeByte(byte);
    }
  }

  /** The serial output as text. */
  serialText(from = 0): string {
    return String.fromCharCode(...this.serial.slice(from).map((s) => s.byte));
  }
}
