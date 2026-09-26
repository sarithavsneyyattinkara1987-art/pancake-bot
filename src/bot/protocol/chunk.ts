/**
 * Chunk payload decoding for protocol 774 (1.21.11).
 *
 * `map_chunk` layout (774): x, z, heightmaps (typed list of long arrays — a
 * 1.21.5+ change from the older NBT compound), varint-prefixed chunk data,
 * block entities and light arrays. Only the parts the bot needs are decoded:
 * the section paletted containers that hold block states.
 *
 * Sections are parsed bottom-up until the chunk-data buffer is exhausted, so
 * the decoder works for any world height without needing the dimension
 * registry first. Block state ids stay numeric; naming them is the block
 * registry's job (blockRegistry.ts).
 */
import { MCReader, PacketError } from "./primitives";

export const SECTION_BLOCKS = 4096;

export interface PalettedContainer {
  bits: number;
  palette: number[] | null;
  /** Decoded values, one per entry (4096 for block states, 64 for biomes). */
  values: Uint16Array | null;
  /** Raw longs kept when decoding was skipped. */
  longs: bigint[] | null;
}

export interface ParsedSection {
  blockCount: number;
  states: PalettedContainer;
}

export interface ParsedChunk {
  x: number;
  z: number;
  heightmapTypes: number[];
  heightmapData: bigint[][];
  sections: ParsedSection[];
  /** Bytes of chunk data we could not interpret (diagnostic). */
  leftoverBytes: number;
}

export interface ChunkParseOptions {
  /** Decode section block states (false = only consume bytes). */
  decodeStates?: boolean;
  /** 1.20.5+ packs entries without crossing long boundaries. */
  nonSpanning?: boolean;
}

function readPalettedContainer(
  r: MCReader,
  entries: number,
  maxIndirectBits: number,
  minBits: number,
  options: ChunkParseOptions,
): PalettedContainer {
  const bits = r.u8();
  const nonSpanning = options.nonSpanning !== false;
  const decode = options.decodeStates !== false;

  if (bits === 0) {
    // Single-value palette: one varint id, no data array.
    const paletteId = r.varint();
    return { bits: 0, palette: [paletteId], values: null, longs: null };
  }

  let palette: number[] | null = null;
  if (bits <= maxIndirectBits) {
    const size = r.varint();
    if (size <= 0 || size > 1 << bits) {
      throw new PacketError(`Invalid palette size ${size} for bits ${bits}`);
    }
    palette = [];
    for (let i = 0; i < size; i++) palette.push(r.varint());
  }

  const longCount = r.varint();
  if (longCount < 0 || longCount > 4096 * 4) {
    throw new PacketError(`Invalid palette data length ${longCount}`);
  }
  const longs: bigint[] = [];
  for (let i = 0; i < longCount; i++) longs.push(r.i64());

  if (!decode) return { bits, palette, values: null, longs };

  const valuesPerLong = nonSpanning ? Math.floor(64 / bits) : 0;
  const values = new Uint16Array(entries);
  const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
  let index = 0;
  if (nonSpanning) {
    for (let li = 0; li < longs.length && index < entries; li++) {
      const word = BigInt.asUintN(64, longs[li]);
      for (let vi = 0; vi < valuesPerLong && index < entries; vi++) {
        const shift = BigInt(vi * bits);
        const value = Number((word >> shift) & BigInt(mask));
        values[index++] = value;
      }
    }
  } else {
    // Pre-1.20.5 continuous packing across longs (kept for version overrides).
    let bitBuffer = 0n;
    let consumed = 0n;
    for (const word of longs) {
      bitBuffer |= BigInt.asUintN(64, word) << consumed;
      consumed += 64n;
      while (consumed >= BigInt(bits) && index < entries) {
        values[index++] = Number(bitBuffer & BigInt(mask));
        bitBuffer >>= BigInt(bits);
        consumed -= BigInt(bits);
      }
      if (index >= entries) break;
    }
  }
  void minBits;
  return { bits, palette, values, longs };
}

/** Parse the chunk-data section list (block states + biomes per section). */
export function parseChunkSections(
  r: MCReader,
  options: ChunkParseOptions = {},
): ParsedSection[] {
  const sections: ParsedSection[] = [];
  while (r.remaining >= 3) {
    const start = r.offset;
    const blockCount = r.u16();
    try {
      const states = readPalettedContainer(r, SECTION_BLOCKS, 8, 4, options);
      readPalettedContainer(r, 64, 3, 1, { ...options, decodeStates: false });
      sections.push({ blockCount, states });
    } catch (err) {
      throw new PacketError(
        `Section ${sections.length} parse failed after ${r.offset - start} bytes: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { section: sections.length },
      );
    }
    if (r.remaining > 0 && r.remaining < 3) break;
  }
  return sections;
}

/**
 * Parse a `map_chunk` (0x2c) payload body.
 * `r` must be positioned after the packet id.
 */
export function parseChunkPacket(r: MCReader, options: ChunkParseOptions = {}): ParsedChunk {
  const x = r.i32();
  const z = r.i32();

  const heightmapCount = r.varint();
  if (heightmapCount < 0 || heightmapCount > 16) {
    throw new PacketError(`Implausible heightmap count ${heightmapCount}`);
  }
  const heightmapTypes: number[] = [];
  const heightmapData: bigint[][] = [];
  for (let i = 0; i < heightmapCount; i++) {
    heightmapTypes.push(r.varint());
    const count = r.varint();
    if (count < 0 || count > 1 << 20) throw new PacketError(`Implausible heightmap length ${count}`);
    const longs: bigint[] = [];
    for (let j = 0; j < count; j++) longs.push(r.i64());
    heightmapData.push(longs);
  }

  const dataLength = r.varint();
  if (dataLength < 0 || dataLength > r.remaining) {
    throw new PacketError(`Chunk data length ${dataLength} exceeds remaining ${r.remaining}`);
  }
  const sectionReader = new MCReader(r.bytes(dataLength));
  const sections = parseChunkSections(sectionReader, options);
  const leftoverBytes = sectionReader.remaining;

  return { x, z, heightmapTypes, heightmapData, sections, leftoverBytes };
}

/** Resolve a state id to its palette entry (handles single-value palettes). */
export function sectionValue(states: PalettedContainer, index: number): number {
  if (states.values) {
    const raw = states.values[index];
    if (states.palette) return states.palette[raw] ?? 0;
    return raw;
  }
  if (states.palette) return states.palette[0] ?? 0;
  throw new PacketError("Section values were not decoded");
}
