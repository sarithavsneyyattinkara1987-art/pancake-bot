/**
 * Slot (item stack) decoder for protocol 774.
 *
 * Interprets the data-component layout table (slotData774.ts) so multi-slot
 * containers can be walked exactly: every component payload is consumed with
 * its real wire layout rather than guessed, which is what makes reading the
 * chest GUIs opened by login/register plugins reliable.
 *
 * Failures are contained: `readSlotList` returns `partial: true` plus a
 * diagnostic instead of corrupting packet framing (frames are length-prefixed,
 * so a mis-read only ever affects the remainder of that one packet).
 */
import { MCReader, PacketError } from "./primitives";
import { slotLayoutTable, type SlotLayoutTable } from "./slotData774";
import { readNbt, nbtToText, type NbtValue } from "./nbt";

export interface SlotItem {
  /** Stack size (0 means the slot was empty and this is null instead). */
  count: number;
  itemId: number;
  /** Component type IDs the stack adds / removes (diagnostics). */
  addedComponentCount: number;
  removedComponentCount: number;
  /** Extracted human-readable component data (name, lore, model, raw NBT). */
  components: SlotComponents;
}

export interface SlotComponents {
  name?: string;
  lore?: string[];
  model?: string;
  customName?: string;
  raw?: Record<string, unknown>;
}

export interface SlotListResult {
  slots: (SlotItem | null)[];
  /** True when decoding stopped early; `error` says why. */
  partial: boolean;
  error?: string;
}

const MAX_ARRAY_LENGTH = 1 << 20;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class LayoutReader {
  private readonly table: SlotLayoutTable;
  readonly warnings: string[] = [];

  constructor(table: SlotLayoutTable) {
    this.table = table;
  }

  read(r: MCReader, type: Json, ctx: Record<string, unknown>, depth = 0): unknown {
    if (depth > 48) throw new PacketError("Slot component layout recursion too deep");
    if (typeof type === "string") return this.readNamed(r, type, ctx, depth);
    if (!Array.isArray(type)) {
      if (isPlainObject(type) && typeof type.type !== "undefined") {
        return this.read(r, type.type as Json, ctx, depth + 1);
      }
      throw new PacketError(`Unsupported layout node: ${JSON.stringify(type)}`);
    }
    const [kind, args] = type as [string, Record<string, unknown>];
    switch (kind) {
      case "container": {
        const out: Record<string, unknown> = {};
        for (const field of (args as unknown as { name: string; type: Json }[]) ?? []) {
          const value = this.read(r, field.type, ctx, depth + 1);
          out[field.name] = value;
          if (field.name && field.name !== "_") ctx[field.name] = value;
        }
        return out;
      }
      case "array": {
        let count: number;
        if (typeof args.count === "string") {
          count = Number(ctx[args.count] ?? 0);
        } else if (typeof args.countType === "string") {
          count = readCount(r, args.countType);
        } else {
          count = r.varint();
        }
        if (!Number.isFinite(count) || count < 0) {
          throw new PacketError(`Invalid array count ${count}`);
        }
        if (count > MAX_ARRAY_LENGTH) {
          throw new PacketError(`Array count ${count} exceeds safety limit`);
        }
        const out: unknown[] = [];
        for (let i = 0; i < count; i++) out.push(this.read(r, args.type as Json, ctx, depth + 1));
        return out;
      }
      case "switch": {
        const compare = args.compareTo ? ctx[String(args.compareTo)] : undefined;
        const fields = (args.fields ?? {}) as Record<string, Json>;
        const key = String(compare);
        const branch = Object.prototype.hasOwnProperty.call(fields, key)
          ? fields[key]
          : (args.default as Json | undefined);
        if (branch === undefined) {
          // No matching branch: nothing is on the wire for this field.
          return undefined;
        }
        return this.read(r, branch, ctx, depth + 1);
      }
      case "mapper": {
        const value = this.read(r, args.type as Json, ctx, depth + 1);
        const mappings = (args.mappings ?? {}) as Record<string, string>;
        const mapped = mappings[String(value)];
        return mapped === undefined ? value : mapped;
      }
      case "option": {
        const present = r.varint() !== 0;
        return present ? this.read(r, args.type as Json, ctx, depth + 1) : undefined;
      }
      case "buffer": {
        const countType = (args.countType as string) ?? "varint";
        const length = readCount(r, countType);
        return r.bytes(length);
      }
      case "registryEntryHolder": {
        // Best-effort: 0 selects the inline (direct) value, anything else is a
        // registry reference. Protocol drift here shows up as a contained
        // SlotParseError with a diagnostic, never a framing failure.
        const code = r.varint();
        if (code === 0) {
          return this.read(r, (args.otherwise as Json) ?? "void", ctx, depth + 1);
        }
        return { registryRef: code - 1 };
      }
      case "registryEntryHolderSet": {
        const code = r.varint();
        if (code === 0) {
          const otherwise = args.otherwise as { type?: Json } | undefined;
          return this.read(r, otherwise?.type ?? "void", ctx, depth + 1);
        }
        return { registryRefSet: code - 1 };
      }
      case "restBuffer":
        return r.rest();
      case "void":
        return undefined;
      default:
        throw new PacketError(`Unsupported layout kind "${kind}"`);
    }
  }

  private readNamed(r: MCReader, name: string, ctx: Record<string, unknown>, depth: number): unknown {
    switch (name) {
      case "varint":
        return r.varint();
      case "varlong":
        return r.varlong();
      case "i8":
      case "byte":
        return r.i8();
      case "u8":
        return r.u8();
      case "i16":
      case "short":
        return r.i16();
      case "u16":
        return r.u16();
      case "i32":
        return r.i32();
      case "u32":
        return r.u32();
      case "i64":
        return r.i64();
      case "f32":
      case "float":
        return r.f32();
      case "f64":
      case "double":
        return r.f64();
      case "bool":
        return r.bool();
      case "string":
      case "pstring":
      case "identifier":
        return r.string();
      case "position":
        return r.position();
      case "UUID":
        return r.uuid();
      case "void":
        return undefined;
      case "anonymousNbt":
        return nbtToJson(readNbt(r));
      case "anonOptionalNbt": {
        const present = r.varint() !== 0;
        return present ? nbtToJson(readNbt(r)) : null;
      }
      case "restBuffer":
        return r.rest();
      default: {
        const node = this.table[name];
        if (node === undefined) throw new PacketError(`Unknown layout reference "${name}"`);
        if (node === "native") throw new PacketError(`Primitive layout "${name}" not handled`);
        return this.read(r, node as Json, ctx, depth + 1);
      }
    }
  }
}

function readCount(r: MCReader, countType: string): number {
  switch (countType) {
    case "u8":
      return r.u8();
    case "i16":
      return r.i16();
    case "u16":
      return r.u16();
    case "i32":
      return r.i32();
    default:
      return r.varint();
  }
}

/** Convert an NBT value into plain JS for component inspection. */
function nbtToJson(tag: NbtValue | null): unknown {
  if (!tag) return null;
  switch (tag.type) {
    case "end":
      return null;
    case "byte":
    case "short":
    case "int":
    case "float":
    case "double":
      return tag.value;
    case "long":
      return tag.value.toString();
    case "byteArray":
      return Array.from(tag.value);
    case "string":
      return tag.value;
    case "intArray":
      return tag.value;
    case "longArray":
      return tag.value.map((v) => v.toString());
    case "list":
      return tag.value.map(nbtToJson);
    case "compound": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tag.value)) out[k] = nbtToJson(v);
      return out;
    }
    default:
      return null;
  }
}

let cachedReader: LayoutReader | null = null;
function layoutReader(): LayoutReader {
  if (!cachedReader) cachedReader = new LayoutReader(slotLayoutTable());
  return cachedReader;
}

/**
 * Read one slot. Returns null for an empty slot. Throws PacketError when the
 * payload does not match the known layout (callers downgrade that to a
 * contained diagnostic).
 */
export function readSlot(r: MCReader): SlotItem | null {
  const count = r.varint();
  if (count === 0) return null;
  const ctx: Record<string, unknown> = { itemCount: count };
  const layout = layoutReader();
  const before = r.offset;
  const slotLayout = slotLayoutTable().Slot as Json;
  // Slot = container[ itemCount, switch(itemCount) ] — itemCount is already
  // consumed above, so decode the switch branch directly.
  let branch: Json = slotLayout;
  if (Array.isArray(slotLayout) && slotLayout[0] === "container") {
    const fields = (slotLayout[1] ?? []) as { name: string; type: Json }[];
    branch = fields[1]?.type ?? "void";
  }
  const value = layout.read(r, branch, ctx, 1) as Record<string, unknown> | undefined;
  const item = (value ?? ctx) as Record<string, unknown>;
  const itemId = Number(item.itemId ?? ctx.itemId ?? 0);
  const added = Number(item.addedComponentCount ?? ctx.addedComponentCount ?? 0);
  const removed = Number(item.removedComponentCount ?? ctx.removedComponentCount ?? 0);
  if (r.offset <= before) {
    throw new PacketError("Slot decoder made no progress", { offset: r.offset });
  }
  return {
    count,
    itemId,
    addedComponentCount: added,
    removedComponentCount: removed,
    components: extractComponents(ctx),
  };
}

function extractComponents(ctx: Record<string, unknown>): SlotComponents {
  const out: SlotComponents = {};
  const components = ctx.components as { type?: string; data?: unknown }[] | undefined;
  if (!Array.isArray(components)) return out;
  const raw: Record<string, unknown> = {};
  for (const entry of components) {
    if (!entry || typeof entry.type !== "string") continue;
    const name = entry.type;
    raw[name] = entry.data;
    if (name === "custom_name") out.customName = toDisplayText(entry.data);
    if (name === "item_name") out.name = toDisplayText(entry.data);
    if (name === "item_model" && typeof entry.data === "string") out.model = entry.data;
    if (name === "lore" && Array.isArray(entry.data)) {
      out.lore = entry.data.map(toDisplayText).filter((s: string) => s.length > 0);
    }
  }
  if (Object.keys(raw).length > 0) out.raw = raw;
  return out;
}

function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return nbtToText(value as unknown as NbtValue);
    } catch {
      return "";
    }
  }
  return "";
}

/** Read a fixed-length list of slots, containing any decode failure. */
export function readSlotList(r: MCReader, count: number): SlotListResult {
  const slots: (SlotItem | null)[] = [];
  for (let i = 0; i < count; i++) {
    try {
      slots.push(readSlot(r));
    } catch (err) {
      return {
        slots,
        partial: true,
        error: `Stopped after ${i}/${count} slots: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { slots, partial: false };
}

/** Reset memoized layout readers (tests swap tables). */
export function resetSlotCaches(): void {
  cachedReader = null;
}
