/**
 * Packet framing + compression.
 *
 * Wire format (always length-prefixed):
 *   [varint length][payload]
 * With compression enabled (threshold >= 0):
 *   [varint length][varint dataLength][data]
 * where dataLength == 0 means the payload is uncompressed, otherwise `data`
 * is zlib-compressed and must inflate to exactly dataLength bytes.
 *
 * The framer is incremental so TCP (or transport) chunks can split frames at
 * any byte boundary, and it bounds frame sizes so malformed input cannot make
 * the bot allocate without limit.
 */
import type { ZlibCodec } from "./compression";
import { MCReader, PacketError } from "./primitives";

/** 16 MiB: generous for chunk packets, small enough to stop memory abuse. */
export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

export class PacketFramer {
  private buffer = new Uint8Array(0);

  /** Feed bytes; returns complete frames (payload only, length prefix removed). */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (true) {
      const reader = new MCReader(this.buffer, offset);
      let length: number;
      try {
        length = reader.varint();
      } catch {
        break; // incomplete varint, wait for more data
      }
      if (length > MAX_FRAME_LENGTH) {
        throw new PacketError(`Frame length ${length} exceeds limit ${MAX_FRAME_LENGTH}`);
      }
      const start = reader.offset;
      if (start + length > this.buffer.byteLength) break; // incomplete frame
      frames.push(this.buffer.slice(start, start + length));
      offset = start + length;
    }
    this.buffer = offset > 0 ? this.buffer.slice(offset) : this.buffer;
    return frames;
  }

  get pendingBytes(): number {
    return this.buffer.byteLength;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

export interface FrameCodec {
  /** -1 disables compression; >= 0 is the packet compression threshold. */
  threshold: number;
  zlib: ZlibCodec;
}

/** Wrap a packet payload in the outer length prefix. */
function wrap(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 5);
  let length = payload.byteLength;
  let i = 0;
  do {
    const byte = length & 0x7f;
    length >>>= 7;
    out[i++] = length === 0 ? byte : byte | 0x80;
  } while (length !== 0);
  out.set(payload, i);
  return out.slice(0, i + payload.byteLength);
}

/** Encode an outbound packet payload according to the active threshold. */
export async function encodeFrame(payload: Uint8Array, codec: FrameCodec): Promise<Uint8Array> {
  if (codec.threshold < 0) return wrap(payload);
  if (payload.byteLength < codec.threshold) {
    const inner = new Uint8Array(payload.byteLength + 1);
    inner[0] = 0;
    inner.set(payload, 1);
    return wrap(inner);
  }
  const compressed = await codec.zlib.compress(payload);
  const inner = new Uint8Array(compressed.byteLength + 5);
  // dataLength varint prefix
  let length = payload.byteLength;
  let i = 0;
  do {
    const byte = length & 0x7f;
    length >>>= 7;
    inner[i++] = length === 0 ? byte : byte | 0x80;
  } while (length !== 0);
  inner.set(compressed, i);
  return wrap(inner.slice(0, i + compressed.byteLength));
}

/** Decode an inbound frame back to a packet payload (id + body). */
export async function decodeFrame(frame: Uint8Array, codec: FrameCodec): Promise<Uint8Array> {
  if (codec.threshold < 0) return frame;
  const r = new MCReader(frame);
  const dataLength = r.varint();
  if (dataLength === 0) return r.rest();
  const compressed = r.rest();
  let inflated: Uint8Array;
  try {
    inflated = await codec.zlib.decompress(compressed);
  } catch (err) {
    throw new PacketError(
      `Failed to inflate packet: ${err instanceof Error ? err.message : String(err)}`,
      { dataLength, compressedBytes: compressed.byteLength },
    );
  }
  if (inflated.byteLength !== dataLength) {
    throw new PacketError(
      `Inflated packet size ${inflated.byteLength} does not match declared ${dataLength}`,
    );
  }
  return inflated;
}
