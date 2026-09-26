/**
 * Outbound packet encoders for protocol 774 (Minecraft Java 1.21.11).
 *
 * Field order/layout follows minecraft-data's 1.21.11 protocol.json,
 * cross-checked against MCProtocolLib implementations for the packets the bot
 * actually sends (client information, resource-pack response, container
 * clicks, chat, movement, digging/placing).
 */
import { MCWriter, type MCReader } from "./primitives";

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

// ------------------------------------------------------------------- status

export function buildStatusRequest(): (w: MCWriter) => void {
  return () => {
    /* ping_start has no body */
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

export function buildChatCommand(command: string): (w: MCWriter) => void {
  return (w) => {
    w.string(command);
  };
}

export function buildArmAnimation(hand = 0): (w: MCWriter) => void {
  return (w) => {
    w.varint(hand);
  };
}

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

/** status: 0 start, 1 cancel, 2 finish, 3 drop stack, 4 drop item, 5 shoot/finish arrow */
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
    w.bool(false); // insideBlock
    w.bool(false); // worldBorderHit
    w.varint(sequence);
  };
}

export function buildUseItem(hand = 0, sequence = 1): (w: MCWriter) => void {
  return (w) => {
    w.varint(hand);
    w.varint(sequence);
    w.f32(0); // rotation x
    w.f32(0); // rotation y
  };
}

export function buildUseEntity(
  target: number,
  mouse: number,
  sneaking: boolean,
  hand = 0,
): (w: MCWriter) => void {
  return (w) => {
    w.varint(target);
    w.varint(mouse);
    if (mouse === 2) {
      w.f32(0);
      w.f32(0);
      w.f32(0);
      w.varint(hand);
    } else if (mouse === 0) {
      w.varint(hand);
    }
    w.bool(sneaking);
  };
}

export function buildHeldItemSlot(slot: number): (w: MCWriter) => void {
  return (w) => {
    w.i16(slot);
  };
}

export interface WindowClickParams {
  windowId: number;
  stateId: number;
  slot: number;
  /** 0 = left click, 1 = right click. */
  button: number;
  /** 0 = pickup, 1 = quick move (shift-click), ... */
  mode: number;
}

/**
 * Click Container. `changedSlots` is sent empty and the carried item as
 * absent — servers treat any mismatch as a desync and re-sync the container,
 * which is safe for driving login GUI buttons.
 */
export function buildWindowClick(params: WindowClickParams): (w: MCWriter) => void {
  return (w) => {
    w.varint(params.windowId);
    w.varint(params.stateId);
    w.i16(params.slot);
    w.i8(params.button);
    w.i8(params.mode);
    w.varint(0); // changed slots
    w.bool(false); // carried item absent
  };
}

export function buildCloseWindow(windowId: number): (w: MCWriter) => void {
  return (w) => {
    w.varint(windowId);
  };
}

/** Sign text update (used by plugins that collect passwords via signs). */
export function buildSignUpdate(
  pos: { x: number; y: number; z: number },
  lines: [string, string, string, string],
): (w: MCWriter) => void {
  return (w) => {
    w.position(pos.x, pos.y, pos.z);
    w.string(lines[0]);
    w.string(lines[1]);
    w.string(lines[2]);
    w.string(lines[3]);
  };
}

export function buildClientCommand(action: number): (w: MCWriter) => void {
  return (w) => {
    w.varint(action);
  };
}

export function buildResourcePackResponsePlay(id: string, status: number): (w: MCWriter) => void {
  return buildResourcePackResponse(id, status);
}

export function buildCustomClickAction(id: string, payloadPresent: boolean): (w: MCWriter) => void {
  return (w) => {
    w.string(id);
    w.bool(payloadPresent);
  };
}

/** Convenience for reading a raw string from a partially consumed packet. */
export function readRemainingString(r: MCReader): string {
  return r.rest().length > 0 ? r.string() : "";
}
