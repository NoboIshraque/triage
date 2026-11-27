// I²C at transaction level (PLAN §4.7: buses run as transactions, like
// Renode's bus messages): the AVR's TWI peripheral talks to devices by address.
import type { AVRTWI, TWIEventHandler } from 'avr8js';

export interface I2cDevice {
  /** The 7-bit address. */
  readonly address: number;
  /** A transaction to this device starts (`write`: the master writes). */
  start(write: boolean): void;
  /** A byte from the master; returns the device's acknowledge. */
  write(byte: number): boolean;
  /** A byte to the master. */
  read(ack: boolean): number;
  /** The transaction ends. */
  stop(): void;
}

export class I2cBus implements TWIEventHandler {
  private current: I2cDevice | undefined;
  readonly transactions = { count: 0, bytes: 0 };

  constructor(
    private readonly twi: AVRTWI,
    private readonly devices: readonly I2cDevice[],
  ) {}

  start(): void {
    this.twi.completeStart();
  }

  stop(): void {
    this.current?.stop();
    this.current = undefined;
    this.twi.completeStop();
  }

  connectToSlave(address: number, write: boolean): void {
    this.current?.stop();
    this.current = this.devices.find((d) => d.address === address);
    this.current?.start(write);
    if (this.current) this.transactions.count += 1;
    this.twi.completeConnect(this.current !== undefined);
  }

  writeByte(value: number): void {
    this.transactions.bytes += 1;
    this.twi.completeWrite(this.current?.write(value) ?? false);
  }

  readByte(ack: boolean): void {
    this.twi.completeRead(this.current?.read(ack) ?? 0xff);
  }
}
