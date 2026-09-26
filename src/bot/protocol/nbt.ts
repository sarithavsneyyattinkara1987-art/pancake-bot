import { MCReader, PacketError } from "./primitives";

/**
 * Network NBT ("anonymous NBT": tag type byte + payload, no root name, the
 * format used since 1.20.2) plus a tolerant text-component flattener.
 *
 * Chat components, titles, boss bars, window titles and disconnect reasons
 * travel as NBT in modern protocol versions and as JSON strings in older ones,
 * so `readComponent` auto-detects both and reports drift instead of throwing.
 */

export const NBT_END = 0;
export const NBT_BYTE = 1;
export const NBT_SHORT = 2;
export const NBT_INT = 3;
export const NBT_LONG = 4;
export const NBT_FLOAT = 5;
export const NBT_DOUBLE = 6;
export const NBT_BYTE_ARRAY = 7;
export const NBT_STRING = 8;
export const NBT_LIST = 9;
export const NBT_COMPOUND = 10;
export const NBT_INT_ARRAY = 11;
export const NBT_LONG_ARRAY = 12;

export type NbtValue =
  | { type: "byte"; value: number }
  | { type: "short"; value: number }
  | { type: "int"; value: number }
  | { type: "long"; value: bigint }
  | { type: "float"; value: number }
  | { type: "double"; value: number }
  | { type: "byteArray"; value: Uint8Array }
  | { type: "string"; value: string }
  | { type: "list"; value: NbtValue[] }
  | { type: "compound"; value: Record<string, NbtValue> }
  | { type: "intArray"; value: number[] }
  | { type: "longArray"; value: bigint[] }
  | { type: "end" };

function readUtf8(r: MCReader): string {
  const len = r.u16();
  const raw = r.bytes(len);
  let out = "";
  for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw[i]);
  return decodeLatin1(out);
}

/** Decode UTF-8 bytes manually (avoids allocating subarrays per string). */
function decodeLatin1(escaped: string): string {
  const bytes = new Uint8Array(escaped.length);
  for (let i = 0; i < escaped.length; i++) bytes[i] = escaped.charCodeAt(i) & 0xff;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function readNbt(r: MCReader): NbtValue {
  const type = r.u8();
  return readNbtPayload(r, type);
}

function readNbtPayload(r: MCReader, type: number): NbtValue {
  switch (type) {
    case NBT_END:
      return { type: "end" };
    case NBT_BYTE:
      return { type: "byte", value: r.i8() };
    case NBT_SHORT:
      return { type: "short", value: r.i16() };
    case NBT_INT:
      return { type: "int", value: r.i32() };
    case NBT_LONG:
      return { type: "long", value: r.i64() };
    case NBT_FLOAT:
      return { type: "float", value: r.f32() };
    case NBT_DOUBLE:
      return { type: "double", value: r.f64() };
    case NBT_BYTE_ARRAY: {
      const len = r.i32();
      return { type: "byteArray", value: r.bytes(Math.max(0, len)) };
    }
    case NBT_STRING:
      return { type: "string", value: readUtf8(r) };
    case NBT_LIST: {
      const childType = r.u8();
      const len = r.i32();
      const items: NbtValue[] = [];
      for (let i = 0; i < len; i++) items.push(readNbtPayload(r, childType));
      return { type: "list", value: items };
    }
    case NBT_COMPOUND: {
      const out: Record<string, NbtValue> = {};
      while (true) {
        const childType = r.u8();
        if (childType === NBT_END) break;
        const name = readUtf8(r);
        out[name] = readNbtPayload(r, childType);
      }
      return { type: "compound", value: out };
    }
    case NBT_INT_ARRAY: {
      const len = r.i32();
      const items: number[] = [];
      for (let i = 0; i < len; i++) items.push(r.i32());
      return { type: "intArray", value: items };
    }
    case NBT_LONG_ARRAY: {
      const len = r.i32();
      const items: bigint[] = [];
      for (let i = 0; i < len; i++) items.push(r.i64());
      return { type: "longArray", value: items };
    }
    default:
      throw new PacketError(`Unknown NBT tag type ${type}`, { offset: r.offset });
  }
}

/** Skip an anonymous NBT value (used for packets we log but do not model). */
export function skipNbt(r: MCReader): void {
  readNbt(r);
}

/**
 * Read a text component that may be encoded as anonymous NBT (1.21.x) or as a
 * JSON string (1.20.3-1.21.4 era). Returns the flattened plain text.
 */
export function readComponent(r: MCReader): string {
  if (r.remaining <= 0) return "";
  const first = r.bytes[r.offset];
  if (first === 0x0a /* compound */ || first === 0x08 /* string tag */ || first === 0x09) {
    try {
      return nbtToText(readNbt(r));
    } catch (err) {
      throw new PacketError(`Failed to decode NBT text component: ${errText(err)}`);
    }
  }
  // JSON / plain string fallback: read the remainder as UTF-8.
  const raw = r.rest();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  return jsonishToText(text);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonishToText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return flattenJsonComponent(JSON.parse(trimmed));
    } catch {
      return stripFormatting(text);
    }
  }
  try {
    return stripFormatting(JSON.parse(trimmed));
  } catch {
    return stripFormatting(text);
  }
}

function flattenJsonComponent(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenJsonComponent).join("");
  if (typeof node !== "object") return "";
  const obj = node as Record<string, unknown>;
  let out = "";
  if (typeof obj.text === "string") out += obj.text;
  else if (typeof obj.translate === "string") {
    out += obj.translate;
    if (Array.isArray(obj.with)) out += " " + obj.with.map(flattenJsonComponent).join(" ");
  } else if (typeof obj.selector === "string") out += obj.selector;
  else if (obj.score && typeof obj.score === "object") {
    const score = obj.score as Record<string, unknown>;
    if (typeof score.value === "string") out += score.value;
    else if (typeof score.name === "string") out += score.name;
  } else if (typeof obj.contents === "string") out += obj.contents;
  else if (typeof obj.extra === "undefined" && obj.value !== undefined) {
    out += flattenJsonComponent(obj.value);
  }
  if (Array.isArray(obj.extra)) out += obj.extra.map(flattenJsonComponent).join("");
  return out;
}

/** Flatten an NBT-serialized text component (handles 1.21.9+ tree shape too). */
export function nbtToText(tag: NbtValue | null): string {
  if (!tag) return "";
  if (tag.type === "string") return stripFormatting(tag.value);
  if (tag.type === "list") return tag.value.map(nbtToText).join("");
  if (tag.type !== "compound") return "";
  const obj = tag.value;
  let out = "";
  if (obj.text) out += nbtToText(obj.text);
  else if (obj.translate) {
    out += stripFormatting(nbtToText(obj.translate));
    if (obj.with) out += " " + nbtToText(obj.with);
  } else if (obj.selector) out += nbtToText(obj.selector);
  else if (obj.contents) out += nbtToText(obj.contents);
  else if (obj.value) out += nbtToText(obj.value);
  else if (obj.type && obj.children) out += nbtToText(obj.children);
  else if (obj.type && obj.contents) out += nbtToText(obj.contents);
  if (obj.extra) out += nbtToText(obj.extra);
  if (obj.children && !obj.type) out += nbtToText(obj.children);
  return out;
}

/** Remove § / &-style color codes and reset sequences for matching. */
export function stripFormatting(text: string): string {
  return text.replace(/§[0-9a-fk-or]/gi, "").replace(/&[0-9a-fk-or]/gi, "");
}
