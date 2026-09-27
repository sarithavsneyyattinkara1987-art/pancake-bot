/** Outbound packet encoders for protocol 774 (Minecraft Java 1.21.11).
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