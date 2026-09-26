/**
 * World state: everything the bot knows about the server world, updated from
 * decoded packets. Pure data + accessors — no networking, so it is easy to
 * test and to render from a dashboard.
 */
import { SECTION_BLOCKS, sectionValue, type ParsedChunk, type ParsedSection } from "../protocol/chunk";
import type { SlotItem } from "../protocol/slots";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface EntityState {
  id: number;
  type: number;
  uuid?: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  isPlayer: boolean;
  name?: string;
  lastSeen: number;
}

export interface PlayerInfo {
  uuid: string;
  name?: string;
  gamemode?: number;
  ping?: number;
  listed?: boolean;
  displayName?: string;
}

export interface WindowState {
  windowId: number;
  type: number;
  title: string;
  stateId: number;
  /** slot index -> item (null = empty). */
  slots: (SlotItem | null)[];
  receivedAt: number;
}

export interface ChatLine {
  at: number;
  source: "chat" | "system" | "actionbar" | "title" | "subtitle" | "bossbar" | "sign" | "dialog";
  text: string;
}

export interface ChunkBlocks {
  cx: number;
  cz: number;
  /** Sections indexed from floor(minY / 16). */
  sections: (Uint16Array | null)[];
  minYSection: number;
}

export class WorldState {
  // --- transform ---
  position: Vec3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  onGround = false;
  velocity: Vec3 = { x: 0, y: 0, z: 0 };
  positionReceived = false;
  pendingTeleportId: number | null = null;

  // --- vitals ---
  health = 20;
  food = 20;
  saturation = 5;
  xpLevel = 0;
  xpProgress = 0;
  alive = true;
  gamemode = -1;
  entityId = 0;

  // --- world ---
  dimensionName = "";
  minY = -64;
  height = 384;
  seaLevel = 63;
  spawn: Vec3 | null = null;
  viewCenter = { cx: 0, cz: 0 };
  chunks = new Map<string, ChunkBlocks>();
  chunkPackets = 0;
  chunkBatch: { received: number; desired: number; pending: boolean } = {
    received: 0,
    desired: 0,
    pending: false,
  };

  // --- entities & players ---
  entities = new Map<number, EntityState>();
  players = new Map<string, PlayerInfo>();
  /** entity id for each player uuid once known from spawn packets. */
  playerEntityIds = new Map<string, number>();

  // --- GUI / windows ---
  windows = new Map<number, WindowState>();
  activeWindow: WindowState | null = null;
  signEditor: Vec3 | null = null;

  // --- chat ---
  chatLines: ChatLine[] = [];
  private readonly chatCapacity = 200;

  // --- counters ---
  deaths = 0;
  respawns = 0;
  collectedItems = 0;
  blockUpdates = 0;
  lastDeathAt: number | null = null;
  lastDamageAt: number | null = null;

  // ---------- transform ----------

  setPosition(x: number, y: number, z: number, yaw?: number, pitch?: number): void {
    this.position = { x, y, z };
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = pitch;
    this.positionReceived = true;
  }

  // ---------- vitals ----------

  setHealth(health: number, food: number, saturation: number): void {
    const wasAlive = this.alive;
    this.health = health;
    this.food = food;
    this.saturation = saturation;
    if (health <= 0) {
      if (wasAlive) {
        this.deaths += 1;
        this.lastDeathAt = Date.now();
        this.alive = false;
      }
    } else if (!wasAlive) {
      this.alive = true;
      this.respawns += 1;
    }
  }

  // ---------- chat ----------

  addChat(line: ChatLine): void {
    this.chatLines.push(line);
    if (this.chatLines.length > this.chatCapacity) {
      this.chatLines.splice(0, this.chatLines.length - this.chatCapacity);
    }
  }

  // ---------- entities ----------

  upsertEntity(entity: EntityState): void {
    this.entities.set(entity.id, entity);
  }

  moveEntityRelative(
    id: number,
    dx: number,
    dy: number,
    dz: number,
    yaw?: number,
    pitch?: number,
    onGround?: boolean,
  ): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    // Deltas are fixed-point (1/4096 of a block).
    entity.x += dx / 4096;
    entity.y += dy / 4096;
    entity.z += dz / 4096;
    if (yaw !== undefined) entity.yaw = yaw;
    if (pitch !== undefined) entity.pitch = pitch;
    if (onGround !== undefined) entity.onGround = onGround;
    entity.lastSeen = Date.now();
  }

  removeEntities(ids: number[]): number {
    let removed = 0;
    for (const id of ids) {
      if (this.entities.delete(id)) removed++;
    }
    return removed;
  }

  nearbyEntities(center: Vec3, radius: number): EntityState[] {
    const r2 = radius * radius;
    const out: EntityState[] = [];
    for (const entity of this.entities.values()) {
      const dx = entity.x - center.x;
      const dy = entity.y - center.y;
      const dz = entity.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(entity);
    }
    return out;
  }

  nearbyPlayers(center: Vec3, radius: number): EntityState[] {
    return this.nearbyEntities(center, radius).filter((e) => e.isPlayer);
  }

  // ---------- windows ----------

  openWindow(window: Omit<WindowState, "slots" | "receivedAt">): WindowState {
    const state: WindowState = { ...window, slots: [], receivedAt: Date.now() };
    this.windows.set(window.windowId, state);
    this.activeWindow = state;
    return state;
  }

  setWindowItems(
    windowId: number,
    stateId: number,
    slots: (SlotItem | null)[],
  ): WindowState | null {
    let window = this.windows.get(windowId);
    if (!window) {
      // Inventory window id 0 is the player inventory and may not be announced.
      window = { windowId, type: -1, title: "(inventory)", stateId, slots, receivedAt: Date.now() };
      this.windows.set(windowId, window);
      if (windowId === 0) this.activeWindow = window;
    } else {
      window.stateId = stateId;
      window.slots = slots;
      window.receivedAt = Date.now();
    }
    return window;
  }

  setWindowSlot(windowId: number, slot: number, item: SlotItem | null): void {
    const window = this.windows.get(windowId) ?? this.activeWindow;
    if (!window) return;
    while (window.slots.length <= slot) window.slots.push(null);
    window.slots[slot] = item;
  }

  closeWindow(windowId: number): void {
    this.windows.delete(windowId);
    if (this.activeWindow?.windowId === windowId) this.activeWindow = null;
  }

  // ---------- blocks ----------

  applyChunk(parsed: ParsedChunk): void {
    const key = `${parsed.x},${parsed.z}`;
    const minYSection = Math.floor(this.minY / 16);
    const sections: (Uint16Array | null)[] = [];
    parsed.sections.forEach((section: ParsedSection, index) => {
      sections[index] = materializeSection(section);
    });
    this.chunks.set(key, { cx: parsed.x, cz: parsed.z, sections, minYSection });
    this.chunkPackets += 1;
  }

  unloadChunk(cx: number, cz: number): void {
    this.chunks.delete(`${cx},${cz}`);
  }

  setBlock(x: number, y: number, z: number, stateId: number): void {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const chunk = this.chunks.get(`${cx},${cz}`);
    if (!chunk) return;
    const sectionIndex = Math.floor(y / 16) - chunk.minYSection;
    if (sectionIndex < 0 || sectionIndex >= chunk.sections.length) return;
    let section = chunk.sections[sectionIndex];
    if (!section) {
      // Section was never materialised (e.g. all-air section); create on demand.
      section = new Uint16Array(SECTION_BLOCKS);
      chunk.sections[sectionIndex] = section;
    }
    const lx = x - cx * 16;
    const lz = z - cz * 16;
    const ly = y - Math.floor(y / 16) * 16;
    section[(ly << 8) | (lz << 4) | lx] = stateId;
    this.blockUpdates += 1;
  }

  /** State id at a position, or null when the area is not loaded. */
  blockAt(x: number, y: number, z: number): number | null {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const chunk = this.chunks.get(`${cx},${cz}`);
    if (!chunk) return null;
    const sectionIndex = Math.floor(y / 16) - chunk.minYSection;
    if (sectionIndex < 0 || sectionIndex >= chunk.sections.length) {
      // Above/below world: unloaded is null, out-of-world is treated as air.
      return y < this.minY || y >= this.minY + this.height ? 0 : null;
    }
    const section = chunk.sections[sectionIndex];
    if (!section) return null;
    const lx = x - cx * 16;
    const lz = z - cz * 16;
    const ly = y - Math.floor(y / 16) * 16;
    return section[(ly << 8) | (lz << 4) | lx];
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  reset(): void {
    this.position = { x: 0, y: 0, z: 0 };
    this.positionReceived = false;
    this.pendingTeleportId = null;
    this.health = 20;
    this.food = 20;
    this.saturation = 5;
    this.alive = true;
    this.entities.clear();
    this.players.clear();
    this.playerEntityIds.clear();
    this.windows.clear();
    this.activeWindow = null;
    this.signEditor = null;
    this.chunks.clear();
    this.chunkPackets = 0;
    this.chatLines = [];
    this.signEditor = null;
  }
}

function materializeSection(section: ParsedSection): Uint16Array | null {
  const out = new Uint16Array(SECTION_BLOCKS);
  const states = section.states;
  if (states.values) {
    if (states.palette) {
      for (let i = 0; i < SECTION_BLOCKS; i++) {
        out[i] = states.palette[states.values[i]] ?? 0;
      }
    } else {
      out.set(states.values.subarray(0, SECTION_BLOCKS));
    }
    return out;
  }
  if (states.palette) {
    out.fill(states.palette[0] ?? 0);
    return out;
  }
  return null;
}

export { sectionValue };
