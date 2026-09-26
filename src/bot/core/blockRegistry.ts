/**
 * Runtime block-state registry.
 *
 * The protocol only carries numeric block state ids; turning them into names
 * (and therefore hazard/passability knowledge for pathfinding) needs the block
 * table for the negotiated version. It is fetched at runtime from the
 * minecraft-data mirror (CORS-open, ~860 KB for 1.21.11) with graceful
 * degradation: if the fetch fails the bot keeps running in geometry-only mode
 * and says so instead of guessing.
 */
import type { BotLogger } from "./logger";

export interface BlockInfo {
  id: number;
  name: string;
  displayName: string;
  transparent: boolean;
  hardness: number;
  diggable: boolean;
  /** "empty" = no collision box (grass, torches...), "block" = solid. */
  boundingBox: "empty" | "block";
  material: string;
}

export interface BlockRegistry {
  version: string;
  loadedAt: number;
  count: number;
  byStateId(stateId: number): BlockInfo | null;
  nameOf(stateId: number): string | null;
  isSolid(stateId: number): boolean;
  isAir(stateId: number): boolean;
  isHazard(stateId: number): boolean;
  isFluid(stateId: number): boolean;
  /** Blocks a headless bot should refuse to walk into. */
  hazardNames: Set<string>;
}

/** Blocks that damage, trap or slow the bot — refused by pathfinding. */
const HAZARD_NAMES = new Set([
  "lava",
  "flowing_lava",
  "fire",
  "soul_fire",
  "magma_block",
  "cactus",
  "sweet_berry_bush",
  "campfire",
  "soul_campfire",
  "wither_rose",
  "powder_snow",
  "soul_sand",
  "soul_soil",
  "cobweb",
]);

const FLUID_NAMES = new Set(["water", "lava", "flowing_water", "flowing_lava", "bubble_column"]);

interface RawBlock {
  id: number;
  name: string;
  displayName?: string;
  transparent?: boolean;
  hardness?: number;
  diggable?: boolean;
  boundingBox?: string;
  material?: string;
  minStateId: number;
  maxStateId: number;
}

function buildRegistry(raw: RawBlock[], version: string): BlockRegistry {
  const sorted = [...raw].sort((a, b) => a.minStateId - b.minStateId);
  const ranges = sorted.map((b) => ({
    start: b.minStateId,
    end: b.maxStateId,
    info: {
      id: b.id,
      name: b.name,
      displayName: b.displayName ?? b.name,
      transparent: b.transparent ?? false,
      hardness: b.hardness ?? 0,
      diggable: b.diggable ?? false,
      boundingBox: (b.boundingBox === "empty" ? "empty" : "block") as "empty" | "block",
      material: b.material ?? "default",
    } satisfies BlockInfo,
  }));

  function byStateId(stateId: number): BlockInfo | null {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = ranges[mid];
      if (stateId < range.start) hi = mid - 1;
      else if (stateId > range.end) lo = mid + 1;
      else return range.info;
    }
    return null;
  }

  return {
    version,
    loadedAt: Date.now(),
    count: sorted.length,
    byStateId,
    nameOf: (stateId) => byStateId(stateId)?.name ?? null,
    isSolid: (stateId) => {
      const info = byStateId(stateId);
      if (!info) return stateId !== 0; // unknown: assume solid, conservative
      if (info.name === "air" || info.name === "cave_air" || info.name === "void_air") return false;
      return info.boundingBox !== "empty";
    },
    isAir: (stateId) => stateId === 0,
    isHazard: (stateId) => HAZARD_NAMES.has(byStateId(stateId)?.name ?? ""),
    isFluid: (stateId) => FLUID_NAMES.has(byStateId(stateId)?.name ?? ""),
    hazardNames: HAZARD_NAMES,
  };
}

const registryCache = new Map<string, Promise<BlockRegistry | null>>();

/**
 * Load (and memoize) the block registry for a version string like "1.21.11".
 * Returns null when unavailable — callers must degrade, never guess.
 */
export function loadBlockRegistry(
  version: string,
  options: { fetchImpl?: typeof fetch; logger?: Pick<BotLogger, "warn" | "info" | "debug"> } = {},
): Promise<BlockRegistry | null> {
  const key = version || "unknown";
  const cached = registryCache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<BlockRegistry | null> => {
    const url = `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/${encodeURIComponent(key)}/blocks.json`;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) return null;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        options.logger?.warn(
          "blocks",
          `Block registry unavailable for ${key} (HTTP ${response.status}); ` +
            "pathfinding will use geometry-only rules.",
        );
        return null;
      }
      const raw = (await response.json()) as RawBlock[];
      if (!Array.isArray(raw) || raw.length === 0) {
        options.logger?.warn("blocks", "Block registry payload was empty.");
        return null;
      }
      const registry = buildRegistry(raw, key);
      options.logger?.info(
        "blocks",
        `Block registry loaded for ${key}: ${registry.count} blocks (state-id lookup ready).`,
      );
      return registry;
    } catch (err) {
      options.logger?.warn(
        "blocks",
        `Block registry fetch failed: ${err instanceof Error ? err.message : String(err)}; ` +
          "falling back to geometry-only pathfinding.",
      );
      return null;
    }
  })();

  registryCache.set(key, promise);
  return promise;
}

/** Test helper. */
export function clearRegistryCache(): void {
  registryCache.clear();
}

/** Minimal entity registry: just enough to recognize player entities. */
export interface EntityRegistry {
  playerTypeId: number | null;
  nameOf(typeId: number): string | null;
}

let entityRegistryPromise: Promise<EntityRegistry | null> | null = null;

/**
 * Load the entity type registry for a version (used to tell players apart
 * from mobs without guessing). Degrades to null (heuristics) on failure.
 */
export function loadEntityRegistry(
  version: string,
  options: { fetchImpl?: typeof fetch; logger?: Pick<BotLogger, "info" | "warn"> } = {},
): Promise<EntityRegistry | null> {
  if (entityRegistryPromise) return entityRegistryPromise;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  entityRegistryPromise = (async (): Promise<EntityRegistry | null> => {
    if (!fetchImpl) return null;
    const url = `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/${encodeURIComponent(version)}/entities.json`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) return null;
      const raw = (await response.json()) as Array<{ id: number; name: string }>;
      const names = new Map<number, string>();
      let playerTypeId: number | null = null;
      for (const entity of raw) {
        names.set(entity.id, entity.name);
        if (entity.name === "player") playerTypeId = entity.id;
      }
      options.logger?.info(
        "entities",
        `Entity registry loaded: ${names.size} types (player type id: ${playerTypeId ?? "unknown"}).`,
      );
      return { playerTypeId, nameOf: (id) => names.get(id) ?? null };
    } catch (err) {
      options.logger?.warn(
        "entities",
        `Entity registry unavailable: ${err instanceof Error ? err.message : String(err)}; ` +
          "using tab-list heuristics to identify players.",
      );
      return null;
    }
  })();
  return entityRegistryPromise;
}

/** Test helper. */
export function clearEntityRegistryCache(): void {
  entityRegistryPromise = null;
}
