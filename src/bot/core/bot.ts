/**
 * Bot: the gameplay controller sitting on top of MinecraftClient.
 *
 * Responsibilities:
 *   - lifecycle (connect / disconnect / reconnect with backoff)
 *   - movement: path execution, jumping, sprinting, facing
 *   - pathfinding + following players
 *   - authentication wiring (chat prompts, GUI clicks, sign editors)
 *   - anti-idle, death/respawn, basic self-defence
 *   - command dispatch (shared by the CLI and the web dashboard)
 *   - snapshot() for dashboards (pure data, secrets never included)
 */
import { MinecraftClient, type ServerStatus } from "./client";
import { BotLogger, type LogEntry } from "./logger";
import { ResourcePackHandler, describeResourcePackState } from "./resourcePack";
import { AuthFlow, type AuthAction, type WindowSummary } from "./auth";
import { describeConfig, type BotConfig } from "./config";
import { loadBlockRegistry, loadEntityRegistry, type BlockRegistry } from "./blockRegistry";
import { createWorldView, distance, findPath, type PathResult, type PathStep } from "./pathfinding";
import type { WorldState, Vec3 } from "./world";
import type { Transport } from "../transport/transport";
import * as P from "../protocol/packets";

export type BotActivity =
  | "disconnected"
  | "connecting"
  | "idle"
  | "pathing"
  | "following"
  | "combat"
  | "dead";

export interface NearbyEntityView {
  id: number;
  kind: "player" | "entity";
  name: string;
  type: number;
  distance: number;
  x: number;
  y: number;
  z: number;
}

export interface BotSnapshot {
  activity: BotActivity;
  connection: ReturnType<MinecraftClient["describeConnection"]> | null;
  serverStatus: ServerStatus | null;
  player: {
    username: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    onGround: boolean;
    health: number;
    food: number;
    saturation: number;
    gamemode: number;
    alive: boolean;
    dimension: string;
    pendingTeleport: number | null;
  };
  world: {
    chunksLoaded: number;
    blockUpdates: number;
    entityCount: number;
    nearby: NearbyEntityView[];
    players: Array<{ uuid: string; name?: string; ping?: number; gamemode?: number; listed?: boolean }>;
    recentChat: Array<{ at: number; source: string; text: string }>;
    collectedItems: number;
    deaths: number;
    registryLoaded: boolean;
  };
  resourcePack: ReturnType<typeof describeResourcePackState>;
  auth: ReturnType<AuthFlow["describe"]>;
  navigation: {
    hasPath: boolean;
    pathLength: number;
    pathIndex: number;
    goal: Vec3 | null;
    following: string | null;
    lastPathResult: string | null;
  };
  stats: {
    startedAt: number;
    uptimeMs: number;
    reconnectAttempts: number;
    lastError: string | null;
    authMode: string;
    antiIdle: boolean;
  };
}

export interface BotOptions {
  config: BotConfig;
  logger: BotLogger;
  createTransport: (config: BotConfig) => Transport;
  now?: () => number;
}

const TICK_MS = 50;
const WALK_SPEED = 0.21; // blocks per tick
const SPRINT_SPEED = 0.28;

export class Bot {
  readonly config: BotConfig;
  readonly logger: BotLogger;
  readonly auth: AuthFlow;
  readonly resourcePack: ResourcePackHandler;

  private readonly createTransport: (config: BotConfig) => Transport;
  private readonly now: () => number;
  private clientValue: MinecraftClient | null = null;
  private registry: BlockRegistry | null = null;

  private activityValue: BotActivity = "disconnected";
  private path: PathStep[] = [];
  private pathIndex = 0;
  private goal: Vec3 | null = null;
  private followTarget: string | null = null;
  private lastPathResult: string | null = null;
  private lastRepathAt = 0;
  private sprinting = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private startedAt = Date.now();
  private lastActionAt = Date.now();
  private lastError: string | null = null;
  private authSucceededAt: number | null = null;
  private lastAttackAt = 0;
  private authRegistrations: Array<() => void> = [];

  constructor(options: BotOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.createTransport = options.createTransport;
    this.now = options.now ?? Date.now;
    this.resourcePack = new ResourcePackHandler(options.config.resourcePack, {
      logger: options.logger,
      now: this.now,
    });
    this.auth = new AuthFlow({
      credentials: options.config.credentials,
      gui: options.config.guiAuth,
      logger: options.logger,
      now: this.now,
    });
  }

  get client(): MinecraftClient | null {
    return this.clientValue;
  }

  get world(): WorldState | null {
    return this.clientValue?.world ?? null;
  }

  get activity(): BotActivity {
    return this.activityValue;
  }

  private setActivity(activity: BotActivity): void {
    if (this.activityValue === activity) return;
    this.activityValue = activity;
    this.logger.debug("bot", `Activity -> ${activity}`);
  }

  // ------------------------------------------------------------ lifecycle

  async connect(): Promise<void> {
    if (this.clientValue && this.clientValue.phase !== "idle") {
      return;
    }
    this.intentionalClose = false;
    this.setActivity("connecting");
    this.lastError = null;
    this.startedAt = this.now();
    this.auth.reset();

    const transport = this.createTransport(this.config);
    const client = new MinecraftClient({
      config: this.config,
      transport,
      logger: this.logger,
      resourcePack: this.resourcePack,
      now: this.now,
    });
    this.clientValue = client;
    this.registerClientHandlers(client);

    try {
      await client.connect();
      await client.waitForPlay(this.config.timeouts.loginMs + this.config.timeouts.configurationMs);
      if (client.phase !== "play") {
        throw new Error("Did not reach the play state");
      }
      this.reconnectAttempts = 0;
      this.setActivity("idle");
      this.logger.info("bot", "Bot is in play state and ready.");
      void this.loadRegistries();
      this.startTickLoop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.logger.error("bot", `Connection failed: ${message}`);
      this.setActivity("disconnected");
      this.stopTickLoop();
      this.scheduleReconnect();
      throw err;
    }
  }

  disconnect(reason = "manual disconnect"): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.stopTickLoop();
    this.path = [];
    this.goal = null;
    this.followTarget = null;
    this.setActivity("disconnected");
    this.clientValue?.close(reason);
    this.clientValue = null;
    this.logger.info("bot", `Disconnected: ${reason}`);
  }

  private async loadRegistries(): Promise<void> {
    const [blocks, entities] = await Promise.all([
      loadBlockRegistry(this.config.versionName, { logger: this.logger }),
      loadEntityRegistry(this.config.versionName, { logger: this.logger }),
    ]);
    this.registry = blocks;
    if (this.clientValue && entities?.playerTypeId !== null && entities) {
      this.clientValue.entityTypeId = entities.playerTypeId;
    }
    if (!blocks) {
      this.logger.warn(
        "bot",
        "Block registry unavailable — pathfinding falls back to geometry-only rules.",
      );
    }
  }

  private registerClientHandlers(client: MinecraftClient): void {
    for (const off of this.authRegistrations) off();
    this.authRegistrations = [];
    const add = (off: () => void): void => {
      this.authRegistrations.push(off);
    };

    add(
      client.on("disconnect", (info) => {
        this.stopTickLoop();
        this.setActivity("disconnected");
        this.path = [];
        this.goal = null;
        if (info.reason && info.reason !== "closed locally") this.lastError = info.reason;
        this.scheduleReconnect();
      }),
    );

    add(
      client.on("error", (info) => {
        this.lastError = `${info.context}: ${info.message}`;
      }),
    );

    add(
      client.on("chat", (info) => {
        const source = info.source as Parameters<AuthFlow["observeText"]>[0];
        const actions = this.auth.observeText(source, info.text);
        this.applyAuthActions(actions);
      }),
    );

    add(
      client.on("windowOpen", (info) => {
        const summary = this.windowSummary(info.windowId, info.title);
        this.applyAuthActions(this.auth.observeWindow(summary));
      }),
    );

    add(
      client.on("windowUpdate", (info) => {
        const window = this.world?.windows.get(info.windowId);
        if (!window) return;
        const summary = this.windowSummary(info.windowId, window.title);
        this.applyAuthActions(this.auth.observeWindow(summary));
      }),
    );

    add(
      client.on("windowClose", (info) => {
        this.auth.observeWindowClosed(info.windowId);
      }),
    );

    add(
      client.on("signEditor", () => {
        this.applyAuthActions(this.auth.observeSignEditor());
      }),
    );

    add(
      client.on("death", () => {
        this.setActivity("dead");
        this.path = [];
        this.logger.warn("bot", "Player died; requesting respawn.");
        setTimeout(() => {
          this.clientValue?.sendPlay("client_command", P.buildClientCommand(0));
        }, 1000);
      }),
    );

    add(
      client.on("respawn", () => {
        if (this.activityValue === "dead") this.setActivity("idle");
        this.logger.info("bot", "Respawned.");
      }),
    );

    add(
      client.on("health", () => {
        if (this.activityValue === "dead" && (this.world?.alive ?? false)) {
          this.setActivity("idle");
        }
      }),
    );
  }

  private windowSummary(windowId: number, title: string): WindowSummary {
    const window = this.world?.windows.get(windowId);
    const stateId = window?.stateId ?? 0;
    const items: Record<number, string> = {};
    if (window) {
      window.slots.forEach((slot, index) => {
        if (!slot) return;
        const name =
          slot.components.customName ??
          slot.components.name ??
          slot.components.model ??
          slot.components.lore?.[0] ??
          `item#${slot.itemId}`;
        items[index] = name;
      });
    }
    return { windowId, stateId, title, items };
  }

  private applyAuthActions(actions: AuthAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case "command": {
          const sensitive = /login|register|password/i.test(action.command);
          this.logger.info(
            "auth",
            `Sending authentication command (${action.reason}); ${sensitive ? "secret redacted" : action.command}`,
          );
          this.sendCommandText(action.command);
          this.lastActionAt = this.now();
          break;
        }
        case "click": {
          const delay = this.config.guiAuth.submitDelayMs;
          this.logger.info(
            "auth",
            `Clicking GUI slot ${action.slot} in window ${action.windowId} in ${delay}ms (${action.reason}).`,
          );
          setTimeout(() => {
            const window = this.world?.windows.get(action.windowId);
            const stateId = window?.stateId ?? action.stateId;
            this.clientValue?.sendPlay(
              "window_click",
              P.buildWindowClick({
                windowId: action.windowId,
                stateId,
                slot: action.slot,
                button: 0,
                mode: 0,
              }),
            );
            setTimeout(() => {
              if (this.world?.activeWindow?.windowId === action.windowId) {
                this.clientValue?.sendPlay("close_window", P.buildCloseWindow(action.windowId));
              }
            }, 300);
          }, delay);
          break;
        }
        case "sign": {
          const pos = this.world?.signEditor;
          if (!pos) {
            this.logger.warn("auth", "Sign editor action requested but no editor position is known.");
            break;
          }
          this.clientValue?.sendPlay(
            "update_sign",
            P.buildSignUpdate(pos, [
              action.lines[0] ?? "",
              action.lines[1] ?? "",
              action.lines[2] ?? "",
              action.lines[3] ?? "",
            ]),
          );
          this.logger.info("auth", "Submitted credentials through the sign editor.");
          break;
        }
        case "note":
          this.logger.info("auth", action.note);
          break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || !this.config.reconnect.enabled) return;
    if (this.reconnectAttempts >= this.config.reconnect.maxAttempts) {
      this.logger.error(
        "bot",
        `Giving up reconnecting after ${this.reconnectAttempts} attempts.`,
      );
      return;
    }
    this.reconnectAttempts += 1;
    const delay = this.config.reconnect.delayMs * this.reconnectAttempts;
    this.logger.info(
      "bot",
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/` +
        `${this.config.reconnect.maxAttempts})...`,
    );
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        /* already logged */
      });
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ------------------------------------------------------------ movement

  private startTickLoop(): void {
    this.stopTickLoop();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTickLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick(): void {
    const client = this.clientValue;
    const world = this.world;
    if (!client || client.phase !== "play" || !world || !world.positionReceived) return;

    const now = this.now();

    // Authentication retries/timeouts.
    const authActions = this.auth.tick();
    if (authActions.length > 0) this.applyAuthActions(authActions);

    if (!world.alive) return;

    // Follow controller: keep the goal on the target.
    if (this.followTarget && now - this.lastRepathAt > 900) {
      const target = this.findPlayerPosition(this.followTarget);
      if (target) {
        this.goal = target;
        this.repath(target, 2);
      }
    }

    let moved = false;
    if (this.activityValue === "pathing" || this.activityValue === "following") {
      moved = this.executePathStep();
    }

    // Basic self-defence: swing at anything hostile that is already on top of us.
    if (!moved && now - this.lastAttackAt > 600) {
      moved = this.autoDefend();
    }

    if (!moved) {
      this.setSprint(false);
      if (now - this.lastActionAt > 200) {
        // Idle heartbeat: keep position fresh without any real motion.
        this.lastActionAt = now;
        client.sendPlay("flying", P.buildFlying({ ...world.position, yaw: world.yaw, pitch: world.pitch, onGround: true }));
      }
      this.maybeAntiIdle(now);
    }
  }

  private executePathStep(): boolean {
    const world = this.world;
    const client = this.clientValue;
    if (!world || !client) return false;

    const step = this.path[this.pathIndex];
    if (!step) {
      this.path = [];
      this.goal = null;
      this.setSprint(false);
      this.setActivity(this.followTarget ? "following" : "idle");
      this.logger.info("bot", "Reached target.");
      return false;
    }

    const target: Vec3 = { x: step.x + 0.5, y: step.y, z: step.z + 0.5 };
    const pos = world.position;
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dz = target.z - pos.z;
    const horizontal = Math.hypot(dx, dz);

    if (horizontal < 0.32 && Math.abs(dy) < 0.6) {
      this.pathIndex += 1;
      return true;
    }

    const remaining = this.path.length - this.pathIndex;
    this.setSprint(remaining > 8);

    const speed = this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const distanceStep = Math.min(speed, horizontal);
    const nx = pos.x + (horizontal > 1e-6 ? (dx / horizontal) * distanceStep : 0);
    const nz = pos.z + (horizontal > 1e-6 ? (dz / horizontal) * distanceStep : 0);
    const climb = Math.min(0.4, Math.abs(dy)) * Math.sign(dy);

    const yaw = horizontal > 1e-3 ? (Math.atan2(-dx, dz) * 180) / Math.PI : world.yaw;
    world.setPosition(nx, pos.y + climb, nz, yaw, world.pitch);
    world.onGround = Math.abs(dy) < 0.05;

    const state = {
      x: world.position.x,
      y: world.position.y,
      z: world.position.z,
      yaw: world.yaw,
      pitch: world.pitch,
      onGround: world.onGround,
    };
    client.sendPlay("position_look", P.buildPositionLook(state));
    if (Math.random() < 0.06) {
      client.sendPlay("arm_animation", P.buildArmAnimation(0));
    }
    this.lastActionAt = this.now();
    return true;
  }

  private setSprint(sprint: boolean): void {
    if (sprint === this.sprinting) return;
    const world = this.world;
    if (!world || !this.clientValue) return;
    this.sprinting = sprint;
    this.clientValue.sendPlay(
      "entity_action",
      P.buildEntityAction(world.entityId, sprint ? 1 : 2, 0),
    );
  }

  private maybeAntiIdle(now: number): void {
    if (!this.config.antiIdle.enabled) return;
    if (now - this.lastActionAt < this.config.antiIdle.intervalMs) return;
    this.lastActionAt = now;
    const world = this.world;
    if (!world || !this.clientValue) return;
    const yaw = (world.yaw + 37) % 360;
    world.yaw = yaw;
    this.clientValue.sendPlay(
      "position_look",
      P.buildPositionLook({ ...world.position, yaw, pitch: world.pitch, onGround: true }),
    );
    this.clientValue.sendPlay("arm_animation", P.buildArmAnimation(0));
    this.logger.debug("bot", "Anti-idle: looked around and swung.");
  }

  private autoDefend(): boolean {
    const world = this.world;
    const client = this.clientValue;
    if (!world || !client) return false;
    const hostiles = world
      .nearbyEntities(world.position, 2.6)
      .filter((e) => !e.isPlayer && e.id !== world.entityId);
    if (hostiles.length === 0) return false;
    const target = hostiles[0];
    this.lastAttackAt = this.now();
    client.sendPlay("use_entity", P.buildUseEntity(target.id, 1, false, 0));
    client.sendPlay("arm_animation", P.buildArmAnimation(0));
    this.logger.info(
      "combat",
      `Attacked entity ${target.name ?? `#${target.id}`} (type ${target.type}) at ` +
        `${target.x.toFixed(1)} ${target.y.toFixed(1)} ${target.z.toFixed(1)}.`,
    );
    return true;
  }

  private findPlayerPosition(name: string): Vec3 | null {
    const world = this.world;
    if (!world) return null;
    const lower = name.toLowerCase();
    for (const entity of world.entities.values()) {
      if (entity.isPlayer && entity.name?.toLowerCase() === lower) {
        return { x: entity.x, y: entity.y, z: entity.z };
      }
    }
    for (const player of world.players.values()) {
      if (player.name?.toLowerCase() === lower) {
        // Tab entry without a spawned entity: no position known yet.
        return null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ navigation

  private repath(goal: Vec3, tolerance: number): PathResult | null {
    const world = this.world;
    if (!world) return null;
    const view = createWorldView({
      blockAt: (x, y, z) => world.blockAt(x, y, z),
      registry: this.registry,
      minY: world.minY,
      height: world.height,
    });
    const result = findPath(view, world.position, goal, { tolerance });
    this.lastRepathAt = this.now();
    if (result.ok && result.path.length > 0) {
      this.path = result.path;
      this.pathIndex = 0;
      this.lastPathResult = `path of ${result.path.length} steps (${result.explored} nodes explored)`;
    } else {
      this.path = [];
      this.lastPathResult = result.reason ?? "no path";
      this.logger.warn("bot", `Pathfinding failed: ${this.lastPathResult}`);
    }
    return result;
  }

  /** Navigate to absolute coordinates. Returns a human-readable result. */
  goto(x: number, y: number, z: number, tolerance = 0): string {
    const world = this.world;
    if (!world || this.clientValue?.phase !== "play") {
      return "Not connected — connect first.";
    }
    if (!world.positionReceived) {
      return "No position yet — the server has not teleported us in.";
    }
    this.followTarget = null;
    this.goal = { x, y, z };
    const result = this.repath(this.goal, tolerance);
    if (!result) return "Pathfinding unavailable.";
    if (result.ok && result.path.length > 0) {
      this.setActivity("pathing");
      return `Walking to ${x} ${y} ${z} (${result.path.length} steps, ` +
        `${result.explored} nodes explored).`;
    }
    this.goal = null;
    return result.reason ?? "No path found.";
  }

  /** Follow a player by name (re-paths continuously). */
  follow(name: string): string {
    const world = this.world;
    if (!world || this.clientValue?.phase !== "play") {
      return "Not connected — connect first.";
    }
    const known = [...world.players.values()].some(
      (p) => p.name?.toLowerCase() === name.toLowerCase(),
    );
    if (!known) {
      return `Player "${name}" is not in the tab list.`;
    }
    this.followTarget = name;
    this.setActivity("following");
    this.logger.info("bot", `Following ${name}.`);
    return `Following ${name} (stopping within 2 blocks).`;
  }

  stop(): string {
    this.path = [];
    this.goal = null;
    const wasFollowing = this.followTarget;
    this.followTarget = null;
    this.setSprint(false);
    if (this.activityValue !== "disconnected") this.setActivity("idle");
    return wasFollowing ? `Stopped following ${wasFollowing}.` : "Stopped.";
  }

  // ---------------------------------------------------------------- chat

  /** Send chat text; a leading "/" is routed through the command packet. */
  sendCommandText(text: string): void {
    const client = this.clientValue;
    if (!client || client.phase !== "play") {
      this.logger.warn("chat", "Cannot send message: not in play state.");
      return;
    }
    if (text.startsWith("/")) {
      const command = text.slice(1);
      client.sendPlay("chat_command", P.buildChatCommand(command));
      this.logger.info("chat", `Sent command "/${command}" (arguments redacted if sensitive).`);
    } else {
      client.sendPlay("chat_message", P.buildChatMessage(text));
      this.logger.info("chat", `Sent chat: "${text}"`);
    }
    this.lastActionAt = this.now();
  }

  // ------------------------------------------------------------ snapshot

  snapshot(): BotSnapshot {
    const client = this.clientValue;
    const world = this.world;
    const position = world?.position ?? { x: 0, y: 0, z: 0 };
    const nearby: NearbyEntityView[] = world
      ? world
          .nearbyEntities(position, 32)
          .filter((e) => e.id !== world.entityId)
          .map((e) => ({
            id: e.id,
            kind: (e.isPlayer ? "player" : "entity") as "player" | "entity",
            name: e.name ?? (e.isPlayer ? "player" : `type#${e.type}`),
            type: e.type,
            distance: Math.round(distance(position, { x: e.x, y: e.y, z: e.z }) * 10) / 10,
            x: Math.round(e.x * 10) / 10,
            y: Math.round(e.y * 10) / 10,
            z: Math.round(e.z * 10) / 10,
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 12)
      : [];

    return {
      activity: this.activityValue,
      connection: client ? client.describeConnection() : null,
      serverStatus: client?.serverStatus ?? null,
      player: {
        username: this.config.credentials.username,
        x: Math.round(position.x * 100) / 100,
        y: Math.round(position.y * 100) / 100,
        z: Math.round(position.z * 100) / 100,
        yaw: Math.round((world?.yaw ?? 0) * 10) / 10,
        pitch: Math.round((world?.pitch ?? 0) * 10) / 10,
        onGround: world?.onGround ?? false,
        health: world?.health ?? 0,
        food: world?.food ?? 0,
        saturation: world?.saturation ?? 0,
        gamemode: world?.gamemode ?? -1,
        alive: world?.alive ?? true,
        dimension: world?.dimensionName ?? "",
        pendingTeleport: world?.pendingTeleportId ?? null,
      },
      world: {
        chunksLoaded: world?.loadedChunkCount ?? 0,
        blockUpdates: world?.blockUpdates ?? 0,
        entityCount: world?.entities.size ?? 0,
        nearby,
        players: world
          ? [...world.players.values()].map((p) => ({
              uuid: p.uuid,
              name: p.name,
              ping: p.ping,
              gamemode: p.gamemode,
              listed: p.listed,
            }))
          : [],
        recentChat: (world?.chatLines ?? []).slice(-40).map((line) => ({
          at: line.at,
          source: line.source,
          text: line.text,
        })),
        collectedItems: world?.collectedItems ?? 0,
        deaths: world?.deaths ?? 0,
        registryLoaded: Boolean(this.registry),
      },
      resourcePack: describeResourcePackState(this.resourcePack.state),
      auth: this.auth.describe(),
      navigation: {
        hasPath: this.path.length > 0,
        pathLength: this.path.length,
        pathIndex: this.pathIndex,
        goal: this.goal,
        following: this.followTarget,
        lastPathResult: this.lastPathResult,
      },
      stats: {
        startedAt: this.startedAt,
        uptimeMs: this.now() - this.startedAt,
        reconnectAttempts: this.reconnectAttempts,
        lastError: this.lastError,
        authMode: this.config.authMode,
        antiIdle: this.config.antiIdle.enabled,
      },
    };
  }

  /** Redacted config view for dashboards. */
  configView(): Record<string, unknown> {
    return describeConfig(this.config);
  }

  logs(): LogEntry[] {
    return this.logger.snapshot();
  }
}
