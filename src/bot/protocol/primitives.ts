/**
 * Low-level protocol primitives shared by every packet encoder/decoder.
 *
 * Everything is implemented over Uint8Array + DataView so the same code runs
 * unchanged in the browser, in Bun/Node (Termux CLI) and in tests.
 */

export class PacketError extends Error {
  readonly detail?: Record<string, unknown>;
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "PacketError";
    this.detail = detail;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Maximum Minecraft string length (characters, protocol limit). */
export const MAX_STRING_LENGTH = 32767;

export class MCReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  atEnd(): boolean {
    return this.offset >= this.bytes.byteLength;
  }

  fail(message: string): never {
    throw new PacketError(message, {
      offset: this.offset,
      length: this.bytes.byteLength,
    });
  }

  private need(n: number, what: string): void {
    if (this.offset + n > this.bytes.byteLength) {
      this.fail(`Unexpected end of packet while reading ${what}`);
    }
  }

  skip(n: number): void {
    this.need(n, `${n} bytes`);
    this.offset += n;
  }

  u8(): number {
    this.need(1, "byte");
    return this.bytes[this.offset++];
  }

  i8(): number {
    const v = this.u8();
    return v > 0x7f ? v - 0x100 : v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2, "unsigned short");
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  i16(): number {
    this.need(2, "short");
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  i32(): number {
    this.need(4, "int");
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  u32(): number {
    this.need(4, "unsigned int");
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  i64(): bigint {
    this.need(8, "long");
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }

  f32(): number {
    this.need(4, "float");
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.need(8, "double");
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }

  /** Unsigned varint (max 5 bytes). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      this.need(1, "varint");
      const b = this.bytes[this.offset++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        // Varints are unsigned 32-bit; re-interpret negative results.
        return result >>> 0;
      }
      shift += 7;
    }
    return this.fail("Varint too long (max 5 bytes)");
  }

  /** Unsigned varlong (max 10 bytes), returned as a Number where safe. */
  varlong(): number {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      this.need(1, "varlong");
      const b = BigInt(this.bytes[this.offset++]);
      result |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) break;
      shift += 7n;
    }
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
      return this.fail("Varlong exceeds safe integer range");
    }
    return Number(result);
  }

  bytes(n: number): Uint8Array {
    this.need(n, `${n} bytes`);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** Varint-length-prefixed byte array. */
  byteArray(): Uint8Array {
    return this.bytes(this.varint());
  }

  /** Varint-length-prefixed UTF-8 string (protocol "string"/"identifier"). */
  string(maxLength = MAX_STRING_LENGTH): string {
    const length = this.varint();
    if (length > maxLength * 4) {
      this.fail(`String length ${length} exceeds protocol maximum`);
    }
    const raw = this.bytes(length);
    const value = textDecoder.decode(raw);
    if (value.length > maxLength) {
      this.fail(`String length ${value.length} exceeds protocol maximum`);
    }
    return value;
  }

  /** 16-byte UUID rendered in canonical 8-4-4-4-12 form. */
  uuid(): string {
    const raw = this.bytes(16);
    let hex = "";
    for (let i = 0; i < 16; i++) hex += raw[i].toString(16).padStart(2, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Packed position (x:26, z:26, y:12). */
  position(): { x: number; y: number; z: number } {
    const val = this.i64();
    const asNumber = BigInt.asIntN(64, val);
    let x = Number(asNumber >> 38n);
    let z = Number((asNumber >> 12n) & 0x3ffffffn);
    let y = Number(asNumber & 0xfffn);
    if (x > 0x1ffffff) x -= 0x4000000;
    if (z > 0x1ffffff) z -= 0x4000000;
    if (y > 0x7ff) y -= 0x1000;
    return { x, y, z };
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

export class MCWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private length = 0;

  constructor(initial = 64) {
    this.buffer = new Uint8Array(Math.max(16, initial));
    this.view = new DataView(this.buffer.buffer);
  }

  private ensure(n: number): void {
    if (this.length + n <= this.buffer.byteLength) return;
    let next = this.buffer.byteLength * 2;
    while (next < this.length + n) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buffer[this.length++] = v & 0xff;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  i8(v: number): this {
    return this.u8(v);
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v, false);
    this.length += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.length, v, false);
    this.length += 2;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, v, false);
    this.length += 4;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, false);
    this.length += 4;
    return this;
  }

  i64(v: bigint | number): this {
    this.ensure(8);
    this.view.setBigInt64(this.length, BigInt(v), false);
    this.length += 8;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.length, v, false);
    this.length += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.length, v, false);
    this.length += 8;
    return this;
  }

  varint(value: number): this {
    let v = value >>> 0;
    this.ensure(5);
    while (true) {
      if ((v & ~0x7f) === 0) {
        this.buffer[this.length++] = v;
        break;
      }
      this.buffer[this.length++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    return this;
  }

  varlong(value: number): this {
    let v = BigInt.asUintN(64, BigInt(value));
    this.ensure(10);
    while (true) {
      if ((v & ~0x7fn) === 0n) {
        this.buffer[this.length++] = Number(v);
        break;
      }
      this.buffer[this.length++] = Number((v & 0x7fn) | 0x80n);
      v >>= 7n;
    }
    return this;
  }

  raw(data: Uint8Array): this {
    this.ensure(data.byteLength);
    this.buffer.set(data, this.length);
    this.length += data.byteLength;
    return this;
  }

  byteArray(data: Uint8Array): this {
    return this.varint(data.byteLength).raw(data);
  }

  string(value: string): this {
    const encoded = textEncoder.encode(value);
    if (value.length > MAX_STRING_LENGTH) {
      throw new PacketError("String exceeds protocol maximum length");
    }
    return this.byteArray(encoded);
  }

  uuid(value: string): this {
    const hex = value.replace(/-/g, "");
    if (hex.length !== 32) throw new PacketError(`Invalid UUID: ${value}`);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return this.raw(out);
  }

  position(x: number, y: number, z: number): this {
    const packed =
      ((BigInt(x) & 0x3ffffffn) << 38n) |
      ((BigInt(z) & 0x3ffffffn) << 12n) |
      (BigInt(y) & 0xfffn);
    return this.i64(BigInt.asIntN(64, packed));
  }

  done(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Build a packet payload: varint packet id followed by the writer body. */
export function buildPacket(packetId: number, body: (w: MCWriter) => void): Uint8Array {
  const w = new MCWriter(128);
  w.varint(packetId);
  body(w);
  return w.done();
}

/** Read a varint packet id from a decompressed packet payload. */
export function readPacketId(r: MCReader): number {
  return r.varint();
}
