/** Outbound packet encoders for protocol 774 (Minecraft Java 1.21.11).
 *
 * Field order/layout follows minecraft-data's 1.21.11 protocol.json,
 * cross-checked against MCProtocolLib implementations for the packets the
 * bot actually sends (client information, resource-pack response, container
 * clicks, chat, movement, digging/placing, dialog clicks).
 */
import { NBT_COMPOUND, NBT_END, NBT_STRING } from "./nbt";
import { MCWriter } from "./primitives";

export type BuildFn = (w: MCWriter) => void;

// ---------------------------------------------------------------- handshake

export function buildHandshake(
  protocolVersion: number,
  host: string,
  port: number,
  nextState: 1 | 2,
): (w: MCWriter) => void {
  return (w) => {
    w.varint(protocolVersion);
    w.string(host);
    w.u16(port);
    w.varint(nextState);
  };
}

export function buildStatusRequest(): (w: MCWriter) => void {
  return () => {
    /* no body */
  };
}

export function buildStatusPing(time: bigint): (w: MCWriter) => void {
  return (w) => {
    w.i64(time);
  };
}

// -------------------------------------------------------------------- login

export function buildLoginStart(username: string, uuid: string): (w: MCWriter) => void {
  return (w) => {
    w.string(username);
    w.uuid(uuid);
  };
}

export function buildEncryptionResponse(
  sharedSecret: Uint8Array,
  verifyToken: Uint8Array,
): (w: MCWriter) => void {
  return (w) => {
    w.byteArray(sharedSecret);
    w.byteArray(verifyToken);
  };
}

export function buildLoginPluginResponse(
  messageId: number,
  data: Uint8Array | null,
): (w: MCWriter) => void {
  return (w) => {
    w.varint(messageId);
    w.bool(data !== null);
    if (data) w.raw(data);
  };
}

export function buildLoginAcknowledged(): (w: MCWriter) => void {
  return () => {
    /* no body */
  };
}

export function buildCookieResponse(name: string, present: boolean): (w: MCWriter) => void {
  return (w) => {
    w.string(name);
    w.bool(present);
  };
}

// ------------------------------------------------------------- configuration

/** Client Information (configuration + play share the same layout). */
export function buildClientInformation(info: {
  locale?: string;
  viewDistance?: number;
  chatMode?: number;
  chatColors?: boolean;
  skinParts?: number;
  mainHand?: number;
  textFiltering?: boolean;
  allowServerListings?: boolean;
  particleStatus?: number;
}): (w: MCWriter) => void {
  return (w) => {
    w.string(info.locale ?? "en_us");
    w.i8(info.viewDistance ?? 8);
    w.varint(info.chatMode ?? 0);
    w.bool(info.chatColors ?? true);
    w.u8(info.skinParts ?? 0x7f);
    w.varint(info.mainHand ?? 1);
    w.bool(info.textFiltering ?? false);
    w.bool(info.allowServerListings ?? true);
    w.varint(info.particleStatus ?? 0);
  };
}

export interface KnownPack {
  namespace: string;
  id: string;
  version: string;
}

export function buildKnownPacks(packs: KnownPack[]): (w: MCWriter) => void {
  return (w) => {
    w.varint(packs.length);
    for (const pack of packs) {
      w.string(pack.namespace);
      w.string(pack.id);
      w.string(pack.version);
    }
  };
}

export function buildResourcePackResponse(
  id: string,
  status: number,
): (w: MCWriter) => void {
  return (w) => {
    w.uuid(id);
    w.varint(status);
  };
}

export function buildKeepAlive(id: bigint): (w: MCWriter) => void {
  return (w) => {
    w.i64(id);
  };
}

export function buildPong(id: number): (w: MCWriter) => void {
  return (w) => {
    w.i32(id);
  };
}

export function buildFinishConfiguration(): (w: MCWriter) => void {
  return () => {
    /* no body */
  };
}

export function buildPluginMessage(channel: string, data: Uint8Array): (w: MCWriter) => void {
  return (w) => {
    w.string(channel);
    w.raw(data);
  };
}

export function buildBrandPayload(brand = "vanilla"): (w: MCWriter) => void {
  return (w) => {
    w.string(brand);
  };
}

export function buildConfigurationAck(): (w: MCWriter) => void {
  return () => {
    /* no body */
  };
}

/**
 * Custom Click Action (1.21.6+ dialogs). The server opens a dialog and waits
 * for the client to "click" one of its actions; the payload carries the
 * dialog's text inputs (e.g. nLogin's password1/password2) as an anonymous
 * NBT compound of string keys/values.
 */
export function buildCustomClickAction(
  id: string,
  payload?: Record<string, string>,
): (w: MCWriter) => void {
  return (w) => {
    w.string(id);
    if (payload) {
      w.u8(NBT_COMPOUND);
      for (const [key, value] of Object.entries(payload)) {
        w.u8(NBT_STRING);
        writeNbtString(w, key);
        writeNbtString(w, value);
      }
      w.u8(NBT_END);
    } else {
      w.u8(NBT_END);
    }
  };
}

/** NBT strings are u16-length UTF-8 (unlike protocol strings, which are varint). */
function writeNbtString(w: MCWriter, text: string): void {
  const bytes = new TextEncoder().encode(text);
  w.u16(bytes.byteLength);
  w.raw(bytes);
}

// --------------------------------------------------------------------- play

export function buildTeleportConfirm(id: number): (w: MCWriter) => void {
  return (w) => {
    w.varint(id);
  };
}

export interface MovementState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

function movementFlags(onGround: boolean): number {
  return (onGround ? 1 : 0) | 0;
}

export function buildPosition(s: MovementState): (w: MCWriter) => void {
  return (w) => {
    w.f64(s.x);
    w.f64(s.y);
    w.f64(s.z);
    w.u8(movementFlags(s.onGround));
  };
}

export function buildPositionLook(s: MovementState): (w: MCWriter) => void {
  return (w) => {
    w.f64(s.x);
    w.f64(s.y);
    w.f64(s.z);
    w.f32(s.yaw);
    w.f32(s.pitch);
    w.u8(movementFlags(s.onGround));
  };
}

export function buildLook(s: MovementState): (w: MCWriter) => void {
  return (w) => {
    w.f32(s.yaw);
    w.f32(s.pitch);
    w.u8(movementFlags(s.onGround));
  };
}

export function buildFlying(s: MovementState): (w: MCWriter) => void {
  return (w) => {
    w.u8(movementFlags(s.onGround));
  };
}

export function buildTickEnd(): (w: MCWriter) => void {
  return () => {
    /* no body */
  };
}

/**
 * Unsigned chat message. Signature is omitted (null) with an empty
 * acknowledgement bitset, which servers accept when secure profiles are not
 * enforced (the common case for offline-mode servers).
 */
export function buildChatMessage(message: string): (w: MCWriter) => void {
  return (w) => {
    w.string(message);
    w.i64(BigInt(Date.now()));
    w.i64(0n); // salt
    w.bool(false); // no signature
    w.varint(0); // message offset
    w.raw(new Uint8Array(3)); // acknowledged bitset (none)
    w.u8(0); // checksum
  };
}

/** Unsigned chat command (same no-signature stance as buildChatMessage). */
export function buildChatCommand(command: string): (w: MCWriter) => void {
  return (w) => {
    w.string(command);
    w.i64(BigInt(Date.now())); // timestamp
    w.i64(0n); // salt
    w.varint(0); // argument signatures (none)
    w.varint(3); // last-seen bitset: 3 zero bytes (no acknowledgements)
    w.raw(new Uint8Array(3));
    w.u8(0); // checksum
  };
}

/** Client Command: respawn (0), request stats (1), perform respawn screen action (2). */
export function buildClientCommand(actionId: number): (w: MCWriter) => void {
  return (w) => {
    w.varint(actionId);
  };
}

/**
 * Interact with an entity: type 0 interact, 1 attack, 2 interact-at (which
 * additionally carries the cursor floats). Sneaking and jump boost are sent
 * for server-side movement validation.
 */
export function buildUseEntity(
  entityId: number,
  type: number,
  sneaking: boolean,
  jumpBoost = 0,
  cursor?: { x: number; y: number; z: number },
): (w: MCWriter) => void {
  return (w) => {
    w.varint(entityId);
    w.varint(type);
    if (type === 2) {
      w.f32(cursor?.x ?? 0);
      w.f32(cursor?.y ?? 0);
      w.f32(cursor?.z ?? 0);
    }
    w.bool(sneaking);
    w.varint(jumpBoost);
  };
}

/** Swing arm: main hand (0) or off hand (1). */
export function buildArmAnimation(hand = 0): (w: MCWriter) => void {
  return (w) => {
    w.varint(hand);
  };
}

/** Entity action (start/stop sprint 1/2, start/stop sneak 0/3, ...). */
export function buildEntityAction(
  entityId: number,
  actionId: number,
  jumpBoost = 0,
): (w: MCWriter) => void {
  return (w) => {
    w.varint(entityId);
    w.varint(actionId);
    w.varint(jumpBoost);
  };
}

/** Player Action (digging): status, position, face, sequence id. */
export function buildBlockDig(
  status: number,
  pos: { x: number; y: number; z: number },
  face: number,
  sequence: number,
): (w: MCWriter) => void {
  return (w) => {
    w.varint(status);
    w.position(pos.x, pos.y, pos.z);
    w.i8(face);
    w.varint(sequence);
  };
}

/** Place a block: hand, position, face, cursor floats, flags, sequence id. */
export function buildBlockPlace(
  hand: number,
  pos: { x: number; y: number; z: number },
  direction: number,
  cursor: { x: number; y: number; z: number },
  sequence: number,
): (w: MCWriter) => void {
  return (w) => {
    w.varint(hand);
    w.position(pos.x, pos.y, pos.z);
    w.varint(direction);
    w.f32(cursor.x);
    w.f32(cursor.y);
    w.f32(cursor.z);
    w.bool(false); // world border hit
    w.bool(false); // second flag (1.21.9 layout, parsed by the simulator too)
    w.varint(sequence);
  };
}

export interface WindowClickParams {
  windowId: number;
  stateId: number;
  slot: number;
  button: number;
  mode: number;
}

/**
 * Click a container slot. changedSlots are sent empty and the carried item is
 * absent: the server recomputes the diff from its own state for simple clicks
 * (mode 0), which covers GUI authentication buttons.
 */
export function buildWindowClick(p: WindowClickParams): (w: MCWriter) => void {
  return (w) => {
    w.varint(p.windowId);
    w.varint(p.stateId);
    w.i16(p.slot);
    w.i8(p.button);
    w.varint(p.mode);
    w.varint(0); // changed slots: none
    w.varint(0); // carried item: absent (empty slot)
  };
}

export function buildCloseWindow(windowId: number): (w: MCWriter) => void {
  return (w) => {
    w.varint(windowId);
  };
}

/** Update the open sign editor (front text side, four lines). */
export function buildSignUpdate(
  pos: { x: number; y: number; z: number },
  lines: [string, string, string, string],
): (w: MCWriter) => void {
  return (w) => {
    w.position(pos.x, pos.y, pos.z);
    w.bool(true); // front text
    for (const line of lines) w.string(line);
  };
}
