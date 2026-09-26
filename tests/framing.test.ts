import { describe, expect, test } from "bun:test";
import { deflate, inflate } from "node:zlib";
import {
  MAX_FRAME_LENGTH,
  PacketFramer,
  decodeFrame,
  encodeFrame,
  type FrameCodec,
} from "../src/bot/protocol/framing";
import { browserZlib, type ZlibCodec } from "../src/bot/protocol/compression";
import { PacketError } from "../src/bot/protocol/primitives";

const nodeZlib: ZlibCodec = {
  compress(data: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      deflate(data, (err, buf) => (err ? reject(err) : resolve(new Uint8Array(buf))));
    });
  },
  decompress(data: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      inflate(data, (err, buf) => (err ? reject(err) : resolve(new Uint8Array(buf))));
    });
  },
};

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("PacketFramer", () => {
  test("reassembles frames split at every byte boundary", async () => {
    const codec: FrameCodec = { threshold: -1, zlib: nodeZlib };
    const a = await encodeFrame(bytes(0x00, 1, 2, 3), codec);
    const b = await encodeFrame(bytes(0xff, 9, 9), codec);
    const stream = new Uint8Array([...a, ...b]);

    const framer = new PacketFramer();
    const collected: Uint8Array[] = [];
    for (let i = 0; i < stream.byteLength; i++) {
      collected.push(...framer.push(stream.subarray(i, i + 1)));
    }
    expect(collected.length).toBe(2);
    expect(Array.from(collected[0])).toEqual([0x00, 1, 2, 3]);
    expect(Array.from(collected[1])).toEqual([0xff, 9, 9]);
    expect(framer.pendingBytes).toBe(0);
  });

  test("multiple frames in a single chunk", () => {
    const framer = new PacketFramer();
    // [len=2][0x01 0x02][len=1][0x03]
    const frames = framer.push(bytes(0x02, 0x01, 0x02, 0x01, 0x03));
    expect(frames.length).toBe(2);
    expect(Array.from(frames[0])).toEqual([1, 2]);
    expect(Array.from(frames[1])).toEqual([3]);
  });

  test("rejects frames above the size limit", () => {
    const framer = new PacketFramer();
    const huge = MAX_FRAME_LENGTH + 1;
    // varint encode `huge`
    const encoded: number[] = [];
    let v = huge;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      encoded.push(v === 0 ? byte : byte | 0x80);
    } while (v !== 0);
    expect(() => framer.push(new Uint8Array(encoded))).toThrow(PacketError);
  });
});

describe("encodeFrame / decodeFrame without compression", () => {
  const codec: FrameCodec = { threshold: -1, zlib: nodeZlib };

  test("roundtrip is the identity on the payload", async () => {
    const payload = bytes(0x12, 0x34, 0x56);
    const framed = await encodeFrame(payload, codec);
    expect(framed.byteLength).toBe(payload.byteLength + 1); // one length byte
    const decoded = await decodeFrame(framed.subarray(1), codec); // framer strips length
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });
});

describe("encodeFrame / decodeFrame with compression", () => {
  const codec: FrameCodec = { threshold: 16, zlib: nodeZlib };

  test("small packets stay uncompressed (dataLength 0)", async () => {
    const payload = bytes(0x01, 0x02, 0x03);
    const framed = await encodeFrame(payload, codec);
    const decoded = await decodeFrame(framed.subarray(1), codec);
    expect(Array.from(decoded)).toEqual([1, 2, 3]);
  });

  test("large packets compress and roundtrip", async () => {
    const payload = new Uint8Array(512);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 7;
    const framed = await encodeFrame(payload, codec);
    // outer frame must be much smaller than the raw payload
    expect(framed.byteLength).toBeLessThan(payload.byteLength);
    const decoded = await decodeFrame(framed.subarray(1), codec);
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });

  test("declared dataLength mismatch is rejected", async () => {
    const payload = new Uint8Array(64).fill(7);
    const framed = await encodeFrame(payload, codec);
    // Corrupt the inner dataLength varint (first byte after the outer length).
    const corrupted = Uint8Array.from(framed);
    corrupted[1] = 0x21; // inner dataLength = 33...
    corrupted[2] = 0x00; // ...instead of 512
    await expect(decodeFrame(corrupted.subarray(1), codec)).rejects.toThrow(PacketError);
  });
});

describe("browserZlib (CompressionStream)", () => {
  const codec: FrameCodec = { threshold: 16, zlib: browserZlib };

  test.skipIf(typeof CompressionStream === "undefined")(
    "roundtrips through the browser codec",
    async () => {
      const payload = new Uint8Array(300).fill(0xab);
      const framed = await encodeFrame(payload, codec);
      const decoded = await decodeFrame(framed.subarray(1), codec);
      expect(Array.from(decoded)).toEqual(Array.from(payload));
    },
  );
});
