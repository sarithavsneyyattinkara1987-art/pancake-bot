/**
 * Practical A* pathfinding over the loaded block grid.
 *
 * Movement model (grid-based, feet position):
 *   - walk:  neighbour with solid ground at y-1 and two passable blocks
 *   - jump:  neighbour one block higher (costlier; the bot jumps)
 *   - fall:  neighbour up to `maxFall` blocks lower (costly, checked for safe landing)
 *   - diagonals are allowed only when both adjacent cardinal cells are open
 *     (no corner clipping)
 *   - hazards (lava, fire, cactus, ...) and unloaded terrain are never entered
 *
 * Block solidity comes from the runtime block registry; without it the bot
 * degrades to geometry-only rules (unknown = solid) and says so.
 */
import type { BlockRegistry } from "./blockRegistry";
import type { Vec3 } from "./world";

export interface WorldView {
  /** State id, null when the chunk is not loaded. */
  blockAt(x: number, y: number, z: number): number | null;
  registry: BlockRegistry | null;
  minY: number;
  height: number;
}

export interface PathStep {
  x: number;
  y: number;
  z: number;
  action: "walk" | "jump" | "fall" | "step-up";
}

export interface PathResult {
  ok: boolean;
  path: PathStep[];
  explored: number;
  reason?: string;
}

export interface PathOptions {
  maxIterations?: number;
  maxFall?: number;
  /** Blocks considered "arrived" (Chebyshev distance). */
  tolerance?: number;
  allowDiagonal?: boolean;
}

interface Node {
  x: number;
  y: number;
  z: number;
  g: number;
  f: number;
  parent: Node | null;
  action: PathStep["action"];
}

/** Binary min-heap keyed on f. */
class Heap {
  private readonly items: Node[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: Node): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].f <= this.items[i].f) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop(): Node | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.items[left].f < this.items[smallest].f) smallest = left;
        if (right < this.items.length && this.items[right].f < this.items[smallest].f) smallest = right;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function octile(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  const dy = Math.abs(ay - by);
  // Vertical distance costs the *cheapest* legal move: falling adds only 0.4
  // per block (a jump adds 0.5). Counting dy as a full 1 would overestimate
  // paths that fall, making the heuristic inadmissible and A* return
  // suboptimal detours instead of shorter jump/fall routes.
  return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz) + 0.4 * dy;
}

export function createWorldView(
  world: {
    blockAt(x: number, y: number, z: number): number | null;
    registry: BlockRegistry | null;
    minY: number;
    height: number;
  },
): WorldView {
  return {
    blockAt: (x, y, z) => world.blockAt(x, y, z),
    registry: world.registry,
    minY: world.minY,
    height: world.height,
  };
}

export function isSolidAt(view: WorldView, x: number, y: number, z: number): boolean | null {
  const id = view.blockAt(x, y, z);
  if (id === null) return null; // unknown
  if (id === 0) return false;
  if (view.registry) return view.registry.isSolid(id);
  return true; // geometry-only fallback
}

function isHazardAt(view: WorldView, x: number, y: number, z: number): boolean {
  if (!view.registry) return false;
  const id = view.blockAt(x, y, z);
  if (id === null || id === 0) return false;
  return view.registry.isHazard(id);
}

function isFluidAt(view: WorldView, x: number, y: number, z: number): boolean {
  if (!view.registry) return false;
  const id = view.blockAt(x, y, z);
  if (id === null || id === 0) return false;
  return view.registry.isFluid(id);
}

/** true = open (can stand in), false = blocked, null = unknown. */
function isPassable(view: WorldView, x: number, y: number, z: number): boolean | null {
  const id = view.blockAt(x, y, z);
  if (id === null) return null;
  if (id === 0) return true;
  if (!view.registry) return false;
  if (view.registry.isHazard(id)) return false;
  if (view.registry.isFluid(id)) return true; // swimmable, penalised by cost
  return !view.registry.isSolid(id);
}

export function findPath(
  view: WorldView,
  start: Vec3,
  goal: Vec3,
  options: PathOptions = {},
): PathResult {
  const maxIterations = options.maxIterations ?? 6000;
  const maxFall = options.maxFall ?? 3;
  const tolerance = options.tolerance ?? 0;
  const diagonal = options.allowDiagonal !== false;

  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const sz = Math.floor(start.z);
  const gx = Math.floor(goal.x);
  const gy = Math.floor(goal.y);
  const gz = Math.floor(goal.z);

  if (view.blockAt(sx, sy, sz) === null) {
    return { ok: false, path: [], explored: 0, reason: "Start position is not loaded" };
  }

  const reachedGoal = (n: Node): boolean => {
    if (tolerance > 0) {
      const chebyshev = Math.max(Math.abs(n.x - gx), Math.abs(n.z - gz));
      return chebyshev <= tolerance && Math.abs(n.y - gy) <= 1;
    }
    return n.x === gx && n.y === gy && n.z === gz;
  };

  const startNode: Node = { x: sx, y: sy, z: sz, g: 0, f: 0, parent: null, action: "walk" };
  const open = new Heap();
  open.push(startNode);
  const bestG = new Map<string, number>([[key(sx, sy, sz), 0]]);
  let explored = 0;
  let closest: Node = startNode;
  let closestHeuristic = octile(sx, sy, sz, gx, gy, gz);

  const cardinal: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const diagonalSteps: Array<[number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  while (open.size > 0 && explored < maxIterations) {
    const current = open.pop()!;
    explored++;

    if (reachedGoal(current)) {
      return { ok: true, path: reconstruct(current), explored };
    }

    const heuristic = octile(current.x, current.y, current.z, gx, gy, gz);
    if (heuristic < closestHeuristic) {
      closestHeuristic = heuristic;
      closest = current;
    }

    const directions: Array<[number, number, boolean]> = cardinal.map(([dx, dz]) => [dx, dz, false]);
    if (diagonal) {
      for (const [dx, dz] of diagonalSteps) directions.push([dx, dz, true]);
    }

    for (const [dx, dz, isDiagonal] of directions) {
      const nx = current.x + dx;
      const nz = current.z + dz;

      // Diagonal corner check: both cardinal neighbours must be open at body level.
      if (isDiagonal) {
        const sideA = isPassable(view, current.x + dx, current.y, current.z);
        const sideB = isPassable(view, current.x, current.y, current.z + dz);
        if (sideA === false || sideB === false) continue;
        if (sideA === null || sideB === null) continue; // don't squeeze through unknowns
      }

      // Ground under the target column (scan up for step-ups, down for falls).
      const groundHere = isSolidAt(view, nx, current.y - 1, nz);
      if (groundHere === true) {
        const feet = isPassable(view, nx, current.y, nz);
        const head = isPassable(view, nx, current.y + 1, nz);
        if (feet === true && head === true) {
          if (isHazardAt(view, nx, current.y - 1, nz)) continue;
          const fluidPenalty = isFluidAt(view, nx, current.y, nz) ? 1.5 : 0;
          const cost = (isDiagonal ? 1.4142 : 1) + fluidPenalty;
          consider(nx, current.y, nz, current, cost, "walk");
          continue;
        }
      }

      // Step up / jump one block.
      const groundUp = isSolidAt(view, nx, current.y, nz);
      if (groundUp === true) {
        const feet = isPassable(view, nx, current.y + 1, nz);
        const head = isPassable(view, nx, current.y + 2, nz);
        if (feet === true && head === true && !isHazardAt(view, nx, current.y, nz)) {
          const cost = (isDiagonal ? 1.9 : 1.5) + (isFluidAt(view, nx, current.y + 1, nz) ? 1 : 0);
          consider(nx, current.y + 1, nz, current, cost, "jump");
          continue;
        }
      }

      // Fall down (bounded).
      for (let drop = 1; drop <= maxFall; drop++) {
        const fy = current.y - drop;
        if (fy < view.minY) break;
        const feet = isPassable(view, nx, fy, nz);
        if (feet === false) break; // wall in the way
        if (feet === null) break; // unknown terrain
        const head = isPassable(view, nx, fy + 1, nz);
        if (head !== true) break;
        const ground = isSolidAt(view, nx, fy - 1, nz);
        if (ground === null) break;
        if (ground === false) {
          if (drop === maxFall) break; // too far to keep falling
          continue; // keep falling
        }
        if (isHazardAt(view, nx, fy - 1, nz)) break;
        consider(nx, fy, nz, current, (isDiagonal ? 1.4142 : 1) + 0.4 * drop, "fall");
        break;
      }
    }
  }

  if (closest !== startNode) {
    return {
      ok: true,
      path: reconstruct(closest),
      explored,
      reason: `Goal not reachable with ${explored} nodes; returning closest point (${closestHeuristic.toFixed(1)} blocks away).`,
    };
  }
  return {
    ok: false,
    path: [],
    explored,
    reason:
      explored >= maxIterations
        ? `Search limit reached (${maxIterations} nodes)`
        : "No walkable route found (terrain unknown, blocked or hazardous)",
  };

  function consider(
    x: number,
    y: number,
    z: number,
    parent: Node,
    stepCost: number,
    action: PathStep["action"],
  ): void {
    const k = key(x, y, z);
    const g = parent.g + stepCost;
    const existing = bestG.get(k);
    if (existing !== undefined && existing <= g) return;
    bestG.set(k, g);
    open.push({ x, y, z, g, f: g + octile(x, y, z, gx, gy, gz), parent, action });
  }
}

function reconstruct(node: Node): PathStep[] {
  const steps: PathStep[] = [];
  let current: Node | null = node;
  while (current && current.parent) {
    steps.push({ x: current.x, y: current.y, z: current.z, action: current.action });
    current = current.parent;
  }
  steps.reverse();
  return steps;
}

/** Heuristic used by the follow controller to decide when to re-path. */
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
