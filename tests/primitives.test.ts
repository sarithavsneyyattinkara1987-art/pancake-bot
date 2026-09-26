import { describe, expect, test } from "bun:test";
import { MCReader, MCWriter, PacketError, buildPacket, readPacketId } from "../src/bot/protocol/primitives";

function readerOf(data: Uint8Array): MCReader {
  return new MCReader(data);
}

describe("varint / varlong", () => {
  const values = [0, 1, 2, 127, 128, 255, 300, 16383, 16384, 2097151, 2147483647, 4294967295];

  test("roundtrips unsigned varints", () => {
    for (const v of values) {
      const w = new MCWriter();
      w.varint(v);
      const r = readerOf(w.done());
      expect(r.varint()).toBe(v >>> 0);
      expect(r.atEnd()).toBe(true);
    }
  });

  test("roundtrips varlongs", () => {
    for (const v of [0, 1, 127, 128, 65535, 2147483647]) {
      const w = new MCWriter();
      w.varlong(v);
      const r = readerOf(w.done());
      expect(r.varlong()).toBe(v);
    }
  });

  test("varint encoding matches known wire bytes", () => {
    // 300 = 0b1_00101100 -> 0xAC 0x02
    const w = new MCWriter();
    w.varint(300);
    expect(Array.from(w.done())).toEqual([0xac, 0x02]);
  });

  test("truncated varint throws PacketError", () => {
    const r = readerOf(new Uint8Array([0xac]));
    expect(() => r.varint()).toThrow(PacketError);
  });
});

describe("numbers, strings, uuids, positions", () => {
  test("fixed width integers roundtrip", () => {
    const w = new MCWriter();
    w.i8(-5).u8(250).i16(-1234).u16(65535).i32(-123456789).u32(4000000000).f32(3.5).f64(-2.25);
    const r = readerOf(w.done());
    expect(r.i8()).toBe(-5);
    expect(r.u8()).toBe(250);
    expect(r.i16()).toBe(-1234);
    expect(r.u16()).toBe(65535);
    expect(r.i32()).toBe(-123456789);
    expect(r.u32()).toBe(4000000000);
    expect(r.f32()).toBe(3.5);
    expect(r.f64()).toBe(-2.25);
    expect(r.atEnd()).toBe(true);
  });

  test("i64 roundtrips bigints", () => {
    const w = new MCWriter();
    w.i64(-9007199254740993n);
    const r = readerOf(w.done());
    expect(r.i64()).toBe(-9007199254740993n);
  });

  test("strings roundtrip including unicode", () => {
    const w = new MCWriter();
    w.string("hello").string("päncäké ✓ 世界");
    const r = readerOf(w.done());
    expect(r.string()).toBe("hello");
    expect(r.string()).toBe("päncäké ✓ 世界");
  });

  test("uuid roundtrips in canonical form", () => {
    const uuid = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
    const w = new MCWriter();
    w.uuid(uuid);
    expect(w.done().byteLength).toBe(16);
    expect(readerOf(w.done()).uuid()).toBe(uuid);
  });

  test("packed position roundtrips with negatives", () => {
    const cases = [
      { x: 0, y: 64, z: 0 },
      { x: -1234, y: -64, z: 5678 },
      { x: 29999999, y: 2047, z: -29999999 },
      { x: -30000000, y: -2048, z: 1 },
    ];
    for (const pos of cases) {
      const w = new MCWriter();
      w.position(pos.x, pos.y, pos.z);
      const r = readerOf(w.done());
      expect(r.position()).toEqual(pos);
    }
  });

  test("reading past the end throws PacketError", () => {
    const r = readerOf(new Uint8Array([1, 2]));
    expect(() => r.i32()).toThrow(PacketError);
    try {
      r.i32();
    } catch (err) {
      expect(err).toBeInstanceOf(PacketError);
      expect((err as PacketError).message).toMatch(/end of packet/i);
    }
  });
});

describe("packet envelope", () => {
  test("buildPacket prefixes the varint packet id", () => {
    const payload = buildPacket(0x30, (w) => {
      w.i32(42);
    });
    const r = readerOf(payload);
    expect(readPacketId(r)).toBe(0x30);
    expect(r.i32()).toBe(42);
    expect(r.atEnd()).toBe(true);
  });
});
