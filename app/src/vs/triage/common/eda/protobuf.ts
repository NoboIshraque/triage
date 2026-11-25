/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  A small protobuf (proto3) codec driven by message descriptors, for the EDA
 *  engine's triage.eda.v1 messages (engines/eda/triage/api/proto/). Handles what
 *  those messages use: varints, bools, enums, doubles, floats, strings, bytes,
 *  nested and repeated fields (packed numbers), and oneofs as plain optional
 *  fields. No VS Code imports: tested in app/engine-tests.
 *--------------------------------------------------------------------------------------------*/

export type ScalarType = 'uint64' | 'uint32' | 'int32' | 'bool' | 'double' | 'float' | 'string' | 'bytes' | 'enum';

export interface FieldDescriptor {
	readonly name: string;
	readonly number: number;
	/** A scalar type, or a message descriptor for nested messages. */
	readonly type: ScalarType | MessageDescriptor;
	readonly repeated?: boolean;
}

export interface MessageDescriptor {
	readonly name: string;
	readonly fields: readonly FieldDescriptor[];
}

/** A decoded message: field name -> value (arrays for repeated fields). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Message = { [field: string]: any };

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

export class ProtobufError extends Error { }

function wireType(type: ScalarType | MessageDescriptor): number {
	if (typeof type !== 'string') {
		return WIRE_LENGTH;
	}
	switch (type) {
		case 'double': return WIRE_FIXED64;
		case 'float': return WIRE_FIXED32;
		case 'string': case 'bytes': return WIRE_LENGTH;
		default: return WIRE_VARINT;
	}
}

class Writer {
	private buffer = new Uint8Array(256);
	private view = new DataView(this.buffer.buffer);
	length = 0;

	private reserve(bytes: number): void {
		if (this.length + bytes <= this.buffer.byteLength) {
			return;
		}
		let size = this.buffer.byteLength * 2;
		while (size < this.length + bytes) {
			size *= 2;
		}
		const next = new Uint8Array(size);
		next.set(this.buffer.subarray(0, this.length));
		this.buffer = next;
		this.view = new DataView(next.buffer);
	}

	varint(value: number | bigint): void {
		let v = BigInt.asUintN(64, BigInt(value));
		this.reserve(10);
		do {
			let byte = Number(v & 0x7fn);
			v >>= 7n;
			if (v !== 0n) {
				byte |= 0x80;
			}
			this.buffer[this.length++] = byte;
		} while (v !== 0n);
	}

	double(value: number): void {
		this.reserve(8);
		this.view.setFloat64(this.length, value, true);
		this.length += 8;
	}

	float(value: number): void {
		this.reserve(4);
		this.view.setFloat32(this.length, value, true);
		this.length += 4;
	}

	bytes(value: Uint8Array): void {
		this.varint(value.byteLength);
		this.reserve(value.byteLength);
		this.buffer.set(value, this.length);
		this.length += value.byteLength;
	}

	finish(): Uint8Array {
		return this.buffer.slice(0, this.length);
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isDefault(value: unknown): boolean {
	return value === undefined || value === null || value === 0 || value === 0n || value === false || value === '';
}

function writeScalar(writer: Writer, type: ScalarType, value: unknown): void {
	switch (type) {
		case 'double': writer.double(Number(value)); break;
		case 'float': writer.float(Number(value)); break;
		case 'string': writer.bytes(encoder.encode(String(value))); break;
		case 'bytes': writer.bytes(value as Uint8Array); break;
		case 'bool': writer.varint(value ? 1 : 0); break;
		case 'int32': writer.varint(BigInt.asUintN(64, BigInt(Math.trunc(Number(value))))); break;
		default: writer.varint(typeof value === 'bigint' ? value : Math.trunc(Number(value))); break;
	}
}

function encodeInto(writer: Writer, descriptor: MessageDescriptor, message: Message): void {
	for (const field of descriptor.fields) {
		const value = message[field.name];
		if (value === undefined || value === null) {
			continue;
		}
		const values: unknown[] = field.repeated ? value as unknown[] : [value];
		if (typeof field.type !== 'string') {
			for (const item of values) {
				writer.varint((field.number << 3) | WIRE_LENGTH);
				writer.bytes(encodeMessage(field.type, item as Message));
			}
			continue;
		}
		const type = field.type;
		if (field.repeated && wireType(type) !== WIRE_LENGTH) {
			// Packed (proto3's default for repeated numbers).
			if (values.length === 0) {
				continue;
			}
			const packed = new Writer();
			for (const item of values) {
				writeScalar(packed, type, item);
			}
			writer.varint((field.number << 3) | WIRE_LENGTH);
			writer.bytes(packed.finish());
			continue;
		}
		for (const item of values) {
			// proto3: singular fields at their default value are not written (oneof members are,
			// but every oneof member used here is a message, written above).
			if (!field.repeated && isDefault(item)) {
				continue;
			}
			writer.varint((field.number << 3) | wireType(type));
			writeScalar(writer, type, item);
		}
	}
}

export function encodeMessage(descriptor: MessageDescriptor, message: Message): Uint8Array {
	const writer = new Writer();
	encodeInto(writer, descriptor, message);
	return writer.finish();
}

class Reader {
	private offset = 0;
	private readonly view: DataView;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	get done(): boolean {
		return this.offset >= this.bytes.byteLength;
	}

	varint(): bigint {
		let result = 0n;
		let shift = 0n;
		for (; ;) {
			if (this.offset >= this.bytes.byteLength) {
				throw new ProtobufError('truncated varint');
			}
			const byte = this.bytes[this.offset++];
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) {
				return result;
			}
			shift += 7n;
			if (shift > 63n) {
				throw new ProtobufError('varint too long');
			}
		}
	}

	fixed64(): number {
		this.need(8);
		const value = this.view.getFloat64(this.offset, true);
		this.offset += 8;
		return value;
	}

	fixed32(): number {
		this.need(4);
		const value = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return value;
	}

	length(): Uint8Array {
		const size = Number(this.varint());
		this.need(size);
		const out = this.bytes.subarray(this.offset, this.offset + size);
		this.offset += size;
		return out;
	}

	skip(wire: number): void {
		switch (wire) {
			case WIRE_VARINT: this.varint(); break;
			case WIRE_FIXED64: this.need(8); this.offset += 8; break;
			case WIRE_LENGTH: this.length(); break;
			case WIRE_FIXED32: this.need(4); this.offset += 4; break;
			default: throw new ProtobufError(`unsupported wire type ${wire}`);
		}
	}

	private need(bytes: number): void {
		if (this.offset + bytes > this.bytes.byteLength) {
			throw new ProtobufError('truncated message');
		}
	}
}

function scalarFromVarint(type: ScalarType, value: bigint): unknown {
	switch (type) {
		case 'bool': return value !== 0n;
		case 'int32': case 'enum': return Number(BigInt.asIntN(32, value));
		case 'uint32': return Number(BigInt.asUintN(32, value));
		case 'uint64': {
			// Ids and byte counts stay below 2^53; larger values keep their bigint.
			const n = BigInt.asUintN(64, value);
			return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
		}
		default: return Number(value);
	}
}

function readScalar(reader: Reader, type: ScalarType, wire: number): unknown {
	switch (type) {
		case 'double': return reader.fixed64();
		case 'float': return reader.fixed32();
		case 'string': return decoder.decode(reader.length());
		case 'bytes': return reader.length().slice();
		default:
			if (wire !== WIRE_VARINT) {
				throw new ProtobufError(`wire type ${wire} for a ${type}`);
			}
			return scalarFromVarint(type, reader.varint());
	}
}

/** Defaults for every field, as proto3 decoders present them. */
function emptyMessage(descriptor: MessageDescriptor): Message {
	const message: Message = {};
	for (const field of descriptor.fields) {
		if (field.repeated) {
			message[field.name] = [];
		} else if (typeof field.type === 'string') {
			switch (field.type) {
				case 'string': message[field.name] = ''; break;
				case 'bool': message[field.name] = false; break;
				case 'bytes': message[field.name] = new Uint8Array(0); break;
				default: message[field.name] = 0; break;
			}
		}
		// Nested messages stay undefined unless present (oneof members, optional parts).
	}
	return message;
}

export function decodeMessage(descriptor: MessageDescriptor, bytes: Uint8Array): Message {
	const message = emptyMessage(descriptor);
	const byNumber = new Map(descriptor.fields.map(field => [field.number, field]));
	const reader = new Reader(bytes);
	while (!reader.done) {
		const tag = Number(reader.varint());
		const number = tag >>> 3;
		const wire = tag & 7;
		const field = byNumber.get(number);
		if (!field) {
			reader.skip(wire);
			continue;
		}
		if (typeof field.type !== 'string') {
			if (wire !== WIRE_LENGTH) {
				throw new ProtobufError(`${descriptor.name}.${field.name}: expected a message`);
			}
			const value = decodeMessage(field.type, reader.length());
			if (field.repeated) {
				(message[field.name] as Message[]).push(value);
			} else {
				message[field.name] = value;
			}
			continue;
		}
		const type = field.type;
		if (field.repeated && wire === WIRE_LENGTH && wireType(type) !== WIRE_LENGTH) {
			const packed = new Reader(reader.length());
			while (!packed.done) {
				(message[field.name] as unknown[]).push(readScalar(packed, type, wireType(type)));
			}
			continue;
		}
		const value = readScalar(reader, type, wire);
		if (field.repeated) {
			(message[field.name] as unknown[]).push(value);
		} else {
			message[field.name] = value;
		}
	}
	return message;
}

/** Reads field 1 (the id) of a message without decoding the rest: what the broker needs. */
export function peekId(bytes: Uint8Array): number {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const tag = Number(reader.varint());
		if (tag === ((1 << 3) | WIRE_VARINT)) {
			return Number(reader.varint());
		}
		reader.skip(tag & 7);
	}
	return 0;
}
