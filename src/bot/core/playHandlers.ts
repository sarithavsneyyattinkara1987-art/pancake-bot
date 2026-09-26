/**
 * Play-state inbound packet handlers.
 *
 * These update the client's WorldState and emit the coarse events the bot and
 * the dashboards render (chat, health, windows, chunks, ...). Handlers are
 * deliberately defensive: a packet that cannot be parsed logs a diagnostic and
 * stops there — framing is length-based, so one bad packet can never corrupt
 * the stream.
 */
import { MCReader } from "../protocol/primitives";
import { readComponent, readNbt, stripFormatting } from "../protocol/nbt";
import { readSlot, readSlotList } from "../protocol/slots";
import type { MinecraftClient } from "./client";

type Handler = (r: MCReader) => void | Promise<void>;

const REL_X = 0x01;
const REL_Y = 0x02;
const REL_Z = 0x04;
const REL_YAW = 0x08;
const REL_PITCH = 0x10;

const INFO_ADD_PLAYER = 0x01;
const INFO_INIT_CHAT = 0x02;
const INFO_GAME_MODE = 0x04;
const INFO_LISTED = 0x08;
const INFO_LATENCY = 0x10;
const INFO_DISPLAY_NAME = 0x20;
const INFO_HAT = 0x40;
const INFO_LIST_ORDER = 0x80;

export function createPlayHandlers(client: MinecraftClient): Record<string, Handler> {
  const world = client.world;
  const logger = client.logger;

  const chat = (source: "chat" | "system" | "actionbar" | "title" | "subtitle" | "bossbar" | "dialog", text: string) => {
    const cleaned = stripFormatting(text).trim();
    if (!cleaned) return;
    world.addChat({ at: Date.now(), source, text: cleaned });
    client.emit("chat", { source, text: cleaned });
  };

  const handlers: Record<string, Handler> = {
    // ---------------------------------------------------------- lifecycle
    login: (r) => {
      const entityId = r.i32();
      r.bool(); // hardcore
      const worldCount = r.varint();
      const worldNames: string[] = [];
      for (let i = 0; i < worldCount; i++) worldNames.push(r.string());
      r.varint(); // max players
      r.varint(); // view distance
      r.varint(); // simulation distance
      r.bool(); // reduced debug
      r.bool(); // respawn screen
      r.bool(); // limited crafting
      r.varint(); // dimension (registry id)
      const dimensionName = r.string();
      r.i64(); // hashed seed
      const gamemode = r.u8();
      r.i8(); // previous gamemode
      r.bool(); // debug
      r.bool(); // flat
      if (r.bool()) {
        r.string(); // death dimension
        r.position(); // death position
      }
      r.varint(); // portal cooldown
      const seaLevel = r.varint();

      world.entityId = entityId;
      world.gamemode = gamemode;
      world.dimensionName = dimensionName;
      world.seaLevel = seaLevel;

      const dim = client.dimensionTypes.get(dimensionName) ?? findDimensionLike(client, dimensionName);
      if (dim) {
        world.minY = dim.minY;
        world.height = dim.height;
        logger.info(
          "world",
          `Dimension "${dimensionName}": y in [${dim.minY}, ${dim.minY + dim.height}) ` +
            `(${dim.height / 16} sections).`,
        );
      } else {
        logger.warn(
          "world",
          `Dimension "${dimensionName}" has no parsed type yet; assuming overworld height ` +
            `(${world.minY}..${world.minY + world.height}).`,
        );
      }
      logger.info(
        "world",
        `Join game: entity ${entityId}, gamemode ${gamemode}, dimension ${dimensionName}, ` +
          `${worldNames.length} world(s).`,
      );
      client.emit("playStart", { entityId });
    },

    // --------------------------------------------------------- movement
    position: (r) => {
      const teleportId = r.varint();
      const x = r.f64();
      const y = r.f64();
      const z = r.f64();
      const dx = r.f64();
      const dy = r.f64();
      const dz = r.f64();
      const yaw = r.f32();
      const pitch = r.f32();
      const flags = r.u32();

      const pos = world.position;
      const nx = flags & REL_X ? pos.x + x : x;
      const ny = flags & REL_Y ? pos.y + y : y;
      const nz = flags & REL_Z ? pos.z + z : z;
      const nyaw = flags & REL_YAW ? world.yaw + yaw : yaw;
      const npitch = flags & REL_PITCH ? world.pitch + pitch : pitch;

      world.velocity.x += dx;
      world.velocity.y += dy;
      world.velocity.z += dz;
      world.setPosition(nx, ny, nz, nyaw, npitch);
      world.pendingTeleportId = teleportId;

      // Vanilla confirms immediately and echoes its position on the next tick.
      client.sendPlay("teleport_confirm", (w) => {
        w.varint(teleportId);
      });
      const self = {
        x: nx,
        y: ny,
        z: nz,
        yaw: nyaw,
        pitch: npitch,
        onGround: world.onGround,
      };
      client.sendPlay("position_look", buildPosLook(self));
      world.pendingTeleportId = null;
      client.emit("teleport", { id: teleportId, x: nx, y: ny, z: nz, yaw: nyaw, pitch: npitch });
      logger.debug(
        "movement",
        `Server teleport #${teleportId} -> ${nx.toFixed(2)} ${ny.toFixed(2)} ${nz.toFixed(2)}`,
      );
    },

    player_rotation: (r) => {
      world.yaw = r.f32();
      world.pitch = r.f32();
    },

    // ----------------------------------------------------------- vitals
    update_health: (r) => {
      const health = r.f32();
      const food = r.varint();
      const saturation = r.f32();
      world.setHealth(health, food, saturation);
      client.emit("health", { health, food, saturation });
      if (health <= 0) client.emit("death", {});
    },

    respawn: (r) => {
      r.varint(); // dimension registry id
      const name = r.string();
      r.i64(); // hashed seed
      const gamemode = r.u8();
      r.i8(); // previous gamemode
      r.bool();
      r.bool();
      if (r.bool()) {
        r.string();
        r.position();
      }
      r.varint(); // portal cooldown
      const seaLevel = r.varint();

      const previousDimension = world.dimensionName;
      world.dimensionName = name;
      world.gamemode = gamemode;
      world.seaLevel = seaLevel;
      world.alive = true;
      if (previousDimension && previousDimension !== name) {
        world.chunks.clear();
        world.entities.clear();
        const dim = client.dimensionTypes.get(name) ?? findDimensionLike(client, name);
        if (dim) {
          world.minY = dim.minY;
          world.height = dim.height;
        }
        logger.info("world", `Dimension change ${previousDimension} -> ${name}; chunk cache reset.`);
      }
      client.emit("respawn", {});
      client.emit("gameMode", gamemode);
    },

    game_state_change: (r) => {
      const reason = r.varint();
      const value = r.f32();
      if (reason === 3) {
        world.gamemode = Math.floor(value);
        client.emit("gameMode", world.gamemode);
        logger.info("world", `Game mode changed to ${world.gamemode}.`);
      }
    },

    spawn_position: (r) => {
      r.string(); // dimension
      const pos = r.position();
      world.spawn = pos;
      logger.debug("world", `Spawn point: ${pos.x} ${pos.y} ${pos.z}`);
    },

    abilities: (r) => {
      r.i8();
      r.f32();
      r.f32();
    },

    experience: (r) => {
      world.xpProgress = r.f32();
      world.xpLevel = r.varint();
      r.varint(); // total experience
    },

    held_item_slot: (r) => {
      r.varint();
    },

    difficulty: (r) => {
      r.u8();
      r.bool();
    },

    // ------------------------------------------------------------- chat
    system_chat: (r) => {
      const text = readComponent(r);
      const isActionBar = r.remaining > 0 ? r.bool() : false;
      chat(isActionBar ? "actionbar" : "system", text);
    },

    player_chat: (r) => {
      r.varint(); // global index
      const senderUuid = r.uuid();
      r.varint(); // index
      const hasSignature = r.bool();
      if (hasSignature) r.skip(256);
      const plain = r.string();
      const name = world.players.get(senderUuid)?.name ?? shortUuid(senderUuid);
      chat("chat", `${name}: ${plain}`);
      // Remaining signed-chat fields are not needed for a plain text read.
    },

    profileless_chat: (r) => {
      const message = readComponent(r);
      chat("chat", message);
    },

    boss_bar: (r) => {
      r.uuid();
      const action = r.varint();
      if (action === 0 || action === 3) {
        const title = readComponent(r);
        chat("bossbar", title);
      }
    },

    action_bar: (r) => {
      chat("actionbar", readComponent(r));
    },

    set_title_text: (r) => {
      chat("title", readComponent(r));
    },

    set_title_subtitle: (r) => {
      chat("subtitle", readComponent(r));
    },

    playerlist_header: (r) => {
      // header/footer pair; consumed silently.
      try {
        readComponent(r);
      } catch {
        /* ignore */
      }
    },

    // ------------------------------------------------------ tab list
    player_info: (r) => {
      try {
        const action = r.u8();
        const count = r.varint();
        for (let i = 0; i < count; i++) {
          const uuid = r.uuid();
          const existing: Record<string, unknown> = world.players.get(uuid) ?? { uuid };
          if (action & INFO_ADD_PLAYER) {
            existing.name = r.string();
            const props = r.varint();
            for (let p = 0; p < props; p++) {
              r.string();
              r.string();
              if (r.bool()) r.string();
            }
          }
          if (action & INFO_INIT_CHAT) {
            const present = r.varint() !== 0;
            if (present) {
              r.uuid(); // session id
              r.i64(); // expiry
              const keyLen = r.varint();
              r.skip(keyLen);
              const sigLen = r.varint();
              r.skip(sigLen);
            }
          }
          if (action & INFO_GAME_MODE) existing.gamemode = r.varint();
          if (action & INFO_LISTED) existing.listed = r.varint() !== 0;
          if (action & INFO_LATENCY) existing.ping = r.varint();
          if (action & INFO_DISPLAY_NAME) {
            const present = r.varint() !== 0;
            existing.displayName = present ? readComponent(r) : undefined;
          }
          if (action & INFO_HAT) r.bool();
          if (action & INFO_LIST_ORDER) r.varint();
          world.players.set(uuid, existing);
        }
        client.emit("players", {});
      } catch (err) {
        logger.warn("protocol", `player_info parse stopped early: ${errText(err)}`);
      }
    },

    player_remove: (r) => {
      const count = r.varint();
      for (let i = 0; i < count; i++) {
        world.players.delete(r.uuid());
      }
      client.emit("players", {});
    },

    // -------------------------------------------------------- entities
    spawn_entity: (r) => {
      const id = r.varint();
      const uuid = r.uuid();
      const type = r.varint();
      const x = r.f64();
      const y = r.f64();
      const z = r.f64();
      const vx = r.i16();
      const vy = r.i16();
      const vz = r.i16();
      const pitch = r.i8();
      const yaw = r.i8();
      r.i8(); // head pitch
      r.varint(); // object data

      const uuidInTabList = uuid ? world.players.has(uuid) : false;
      const isPlayer =
        (client.entityTypeId !== null && type === client.entityTypeId) ||
        (client.entityTypeId === null && uuidInTabList) ||
        uuidInTabList;
      const name = isPlayer ? client.playerNameForUuid(uuid) : undefined;
      world.upsertEntity({
        id,
        type,
        uuid,
        x,
        y,
        z,
        yaw: yaw * 360 / 256,
        pitch: pitch * 360 / 256,
        vx: vx / 4096,
        vy: vy / 4096,
        vz: vz / 4096,
        onGround: false,
        isPlayer,
        name,
        lastSeen: Date.now(),
      });
      client.emit("entities", {});
    },

    rel_entity_move: (r) => {
      const id = r.varint();
      const dx = r.i16();
      const dy = r.i16();
      const dz = r.i16();
      r.bool();
      world.moveEntityRelative(id, dx, dy, dz);
    },

    entity_move_look: (r) => {
      const id = r.varint();
      const dx = r.i16();
      const dy = r.i16();
      const dz = r.i16();
      const yaw = r.i8();
      const pitch = r.i8();
      r.bool();
      world.moveEntityRelative(id, dx, dy, dz, yaw * 360 / 256, pitch * 360 / 256);
    },

    entity_look: (r) => {
      const id = r.varint();
      const yaw = r.i8();
      const pitch = r.i8();
      r.bool();
      world.moveEntityRelative(id, 0, 0, 0, yaw * 360 / 256, pitch * 360 / 256);
    },

    sync_entity_position: (r) => {
      const id = r.varint();
      const x = r.f64();
      const y = r.f64();
      const z = r.f64();
      const dx = r.f64();
      const dy = r.f64();
      const dz = r.f64();
      r.f32();
      r.f32();
      r.bool();
      const entity = world.entities.get(id);
      if (entity) {
        entity.x = x;
        entity.y = y;
        entity.z = z;
        entity.vx = dx;
        entity.vy = dy;
        entity.vz = dz;
        entity.lastSeen = Date.now();
      }
    },

    entity_teleport: (r) => {
      const id = r.varint();
      const x = r.f64();
      const y = r.f64();
      const z = r.f64();
      r.f64();
      r.f64();
      r.f64();
      const yaw = r.f32();
      const pitch = r.f32();
      r.u32();
      r.bool();
      const entity = world.entities.get(id);
      if (entity) {
        entity.x = x;
        entity.y = y;
        entity.z = z;
        entity.yaw = yaw;
        entity.pitch = pitch;
        entity.lastSeen = Date.now();
      }
    },

    entity_destroy: (r) => {
      const count = r.varint();
      const ids: number[] = [];
      for (let i = 0; i < count; i++) ids.push(r.varint());
      world.removeEntities(ids);
      client.emit("entities", {});
    },

    entity_velocity: (r) => {
      const id = r.varint();
      const vx = r.i16();
      const vy = r.i16();
      const vz = r.i16();
      if (id === world.entityId) {
        world.velocity.x = vx / 8000;
        world.velocity.y = vy / 8000;
        world.velocity.z = vz / 8000;
      } else {
        const entity = world.entities.get(id);
        if (entity) {
          entity.vx = vx / 8000;
          entity.vy = vy / 8000;
          entity.vz = vz / 8000;
        }
      }
    },

    collect: (r) => {
      const collected = r.varint();
      const collector = r.varint();
      const amount = r.varint();
      void collected;
      if (collector === world.entityId) {
        world.collectedItems += amount;
        logger.debug("inventory", `Picked up ${amount} item(s).`);
      }
    },

    entity_status: (r) => {
      r.i32();
      const status = r.i8();
      if (status === 35) logger.debug("combat", "Entity death status observed.");
    },

    // ----------------------------------------------------- inventory GUI
    open_window: (r) => {
      const windowId = r.varint();
      const type = r.varint();
      let title = "(container)";
      try {
        title = readComponent(r);
      } catch {
        /* title unparsable */
      }
      const window = world.openWindow({ windowId, type, title, stateId: 0 });
      logger.info(
        "gui",
        `Container opened: window ${windowId} type ${type} title "${title}" — waiting for contents.`,
      );
      client.emit("windowOpen", { windowId, type, title });
      void window;
    },

    close_window: (r) => {
      const windowId = r.varint();
      world.closeWindow(windowId);
      client.emit("windowClose", { windowId });
      logger.debug("gui", `Container ${windowId} closed.`);
    },

    window_items: (r) => {
      const windowId = r.varint();
      const stateId = r.varint();
      const count = r.varint();
      const list = readSlotList(r, count);
      let carried: ReturnType<typeof readSlot> = null;
      if (!list.partial && r.remaining > 0) {
        try {
          carried = readSlot(r);
        } catch {
          /* carried item optional */
        }
      }
      void carried;
      const window = client.recordWindowItems(windowId, stateId, list.slots);
      if (list.partial) {
        logger.warn(
          "gui",
          `window_items for window ${windowId} only partially decoded: ${list.error}`,
        );
      }
      client.emit("windowUpdate", { windowId, stateId, count: list.slots.length });
      void window;
    },

    set_slot: (r) => {
      const windowId = r.varint();
      r.varint(); // state id
      const slot = r.i16();
      let item = null;
      try {
        item = readSlot(r);
      } catch (err) {
        logger.warn("inventory", `set_slot parse failed: ${errText(err)}`);
        return;
      }
      if (windowId === 0xffffffff || windowId === -1) return; // cursor slot
      world.setWindowSlot(windowId, slot, item);
      if (windowId === 0 || world.activeWindow?.windowId === windowId) {
        client.emit("windowUpdate", {
          windowId,
          stateId: world.activeWindow?.stateId ?? 0,
          count: world.activeWindow?.slots.length ?? 0,
        });
      }
    },

    set_player_inventory: (r) => {
      const slot = r.varint();
      let item = null;
      try {
        item = readSlot(r);
      } catch (err) {
        logger.warn("inventory", `set_player_inventory parse failed: ${errText(err)}`);
        return;
      }
      world.setWindowSlot(0, slot, item);
    },

    set_cursor_item: (r) => {
      try {
        readSlot(r);
      } catch {
        /* cursor contents not needed */
      }
    },

    open_sign_entity: (r) => {
      const pos = r.position();
      world.signEditor = pos;
      logger.info("gui", `Sign editor opened at ${pos.x} ${pos.y} ${pos.z}.`);
      client.emit("signEditor", pos);
    },

    // --------------------------------------------------------- terrain
    map_chunk: (r) => {
      const { cx, cz } = client.ingestChunk(r);
      client.emit("chunk", { cx, cz });
    },

    block_change: (r) => {
      const pos = r.position();
      const state = r.varint();
      world.setBlock(pos.x, pos.y, pos.z, state);
      client.emit("blockUpdate", { x: pos.x, y: pos.y, z: pos.z, state });
    },

    multi_block_change: (r) => {
      const packed = BigInt.asIntN(64, r.i64());
      const y = signExtend(Number(packed & 0xfffffn), 20);
      const z = signExtend(Number((packed >> 20n) & 0x3fffffn), 22);
      const x = signExtend(Number((packed >> 42n) & 0x3fffffn), 22);
      const useSectionCoords = (x & 15) !== 0 || (z & 15) !== 0;
      const originX = useSectionCoords ? x * 16 : x;
      const originZ = useSectionCoords ? z * 16 : z;
      const count = r.varint();
      for (let i = 0; i < count; i++) {
        const record = r.varint();
        const local = record & 0xfff;
        const state = record >>> 12;
        const lx = local & 0x0f;
        const lz = (local >> 4) & 0x0f;
        const ly = (local >> 8) & 0x0f;
        world.setBlock(originX + lx, y + ly, originZ + lz, state);
      }
    },

    unload_chunk: (r) => {
      const z = r.i32();
      const x = r.i32();
      world.unloadChunk(x, z);
    },

    chunk_batch_start: () => {
      world.chunkBatch.pending = true;
      world.chunkBatch.received = 0;
    },

    chunk_batch_finished: (r) => {
      const desired = r.varint();
      world.chunkBatch.desired = desired;
      world.chunkBatch.pending = false;
      // Acknowledge so the server keeps streaming chunks (it stalls otherwise).
      const perTick = Math.max(1, Math.min(desired, 32));
      client.sendPlay("chunk_batch_received", (w) => {
        w.f32(perTick);
      });
      logger.debug("world", `Chunk batch of ${desired} acknowledged at ${perTick}/tick.`);
    },

    update_view_position: (r) => {
      const cx = r.varint();
      const cz = r.varint();
      world.viewCenter = { cx, cz };
    },

    update_view_distance: (r) => {
      r.varint();
    },

    // ----------------------------------------------------------- keep-alive
    keep_alive: (r) => {
      const id = r.i64();
      client.sendPlay("keep_alive", (w) => {
        w.i64(id);
      });
      client.emit("keepAlive", 0);
    },

    ping: (r) => {
      const id = r.i32();
      client.sendPlay("pong", (w) => {
        w.i32(id);
      });
    },

    cookie_request: (r) => {
      const name = r.string();
      client.sendPlay("cookie_response", (w) => {
        w.string(name);
        w.bool(false);
      });
    },

    kick_disconnect: (r) => {
      const reason = readComponent(r);
      logger.warn("connection", `Kicked by server: ${reason}`);
      client.disconnectInternal(`kicked: ${reason}`, true);
    },

    start_configuration: () => {
      logger.info("protocol", "Server requested a return to the configuration phase.");
      client.sendPlay("configuration_acknowledged", () => {});
      client.enterConfigurationPhase();
    },

    add_resource_pack: (r) => {
      void client.handleResourcePackPush(r, "play");
    },

    remove_resource_pack: (r) => {
      const id = r.uuid();
      logger.info("resourcepack", `Server removed resource pack ${id} (play phase).`);
    },

    store_cookie: (r) => {
      r.string();
      r.byteArray();
    },

    transfer: (r) => {
      const host = r.string();
      const port = r.u16();
      logger.warn("connection", `Server requested transfer to ${host}:${port} — ignored.`);
    },

    show_dialog: (r) => {
      try {
        const id = r.string();
        logger.info("gui", `Dialog shown: "${id}"`);
        chat("dialog", id);
      } catch (err) {
        logger.warn("gui", `Unparsable show_dialog: ${errText(err)}`);
      }
    },

    clear_dialog: () => {
      logger.debug("gui", "Dialog cleared.");
    },
  };

  return handlers;
}

function buildPosLook(state: {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}) {
  return (w: {
    f64(v: number): unknown;
    f32(v: number): unknown;
    u8(v: number): unknown;
  }) => {
    w.f64(state.x);
    w.f64(state.y);
    w.f64(state.z);
    w.f32(state.yaw);
    w.f32(state.pitch);
    w.u8(state.onGround ? 1 : 0);
  };
}

function signExtend(value: number, bits: number): number {
  const mask = (1 << bits) - 1;
  const masked = value & mask;
  const signBit = 1 << (bits - 1);
  return masked & signBit ? masked - (1 << bits) : masked;
}

function shortUuid(uuid: string): string {
  return uuid.slice(0, 8);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findDimensionLike(
  client: { dimensionTypes: Map<string, { minY: number; height: number }> },
  name: string,
): { minY: number; height: number } | null {
  const direct = client.dimensionTypes.get(name);
  if (direct) return direct;
  // Level names can differ from the dimension type key; match on the tail.
  const tail = name.split(":").pop();
  for (const [key, value] of client.dimensionTypes) {
    if (key.split(":").pop() === tail) return value;
  }
  return null;
}
