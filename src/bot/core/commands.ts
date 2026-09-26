/**
 * Console command system.
 *
 * One implementation shared by the Termux CLI and the web dashboard so both
 * expose exactly the documented verbs:
 *   connect disconnect say goto follow stop inventory status players
 *   resourcepack auth help
 * plus a few extras (path, attack, reconfigure) that help diagnose behaviour.
 *
 * `runCommand` returns display lines; it never returns a secret (the logger
 * redacts on the way out as a second line of defence).
 */
import type { Bot } from "./bot";
import { statusName } from "./resourcePack";

export interface CommandResult {
  lines: string[];
  /** False when the command itself failed (for exit codes / toasts). */
  ok: boolean;
}

export interface CommandApi {
  bot: Bot;
  connect(): Promise<void>;
  disconnect(reason?: string): void;
}

const HELP_LINES = [
  "connect                 - connect to the server",
  "disconnect [reason]     - close the connection",
  "say <message>           - send chat (leading / runs a command)",
  "goto <x> <y> <z>        - pathfind to coordinates",
  "follow <player|off>     - follow a player from the tab list",
  "stop                    - stop pathing/following",
  "inventory               - show the player inventory",
  "status                  - connection, position, health, auth, packs",
  "players                 - tab list with ping and game mode",
  "resourcepack            - resource-pack request/response detail",
  "auth                    - authentication state detail",
  "path                    - current path/navigation state",
  "help                    - this list",
];

export function runCommand(input: string, api: CommandApi): CommandResult {
  const trimmed = input.trim();
  if (!trimmed) return { lines: [], ok: true };

  // Chat-style: anything starting with / that is not a console verb.
  const [rawName, ...args] = trimmed.split(/\s+/);
  const name = rawName.toLowerCase().replace(/^\//, "");

  switch (name) {
    case "connect":
      return withPromise(
        api.connect().then(() => ({ lines: ["Connecting..."], ok: true })),
        "connect",
      );

    case "disconnect":
      api.disconnect(args.join(" ") || "console disconnect");
      return { lines: ["Disconnected."], ok: true };

    case "say": {
      const message = trimmed.slice(rawName.length).trim();
      if (!message) return { lines: ["Usage: say <message>"], ok: false };
      api.bot.sendCommandText(message);
      return { lines: [`> ${message}`], ok: true };
    }

    case "goto": {
      if (args.length < 3) return { lines: ["Usage: goto <x> <y> <z>"], ok: false };
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some((v) => !Number.isFinite(v))) {
        return { lines: ["goto expects three numbers"], ok: false };
      }
      const message = api.bot.goto(x, y, z, Number(args[3] ?? 0));
      return { lines: [message], ok: !/Not connected|failed|No path/.test(message) };
    }

    case "follow": {
      const target = args[0];
      if (!target || target === "off") {
        const stopped = api.bot.stop();
        return { lines: [stopped], ok: true };
      }
      const message = api.bot.follow(target);
      return { lines: [message], ok: !/not in the tab list|Not connected/.test(message) };
    }

    case "stop":
      return { lines: [api.bot.stop()], ok: true };

    case "inventory":
      return { lines: inventoryLines(api.bot), ok: true };

    case "status":
      return { lines: statusLines(api.bot), ok: true };

    case "players":
      return { lines: playerLines(api.bot), ok: true };

    case "resourcepack":
      return { lines: resourcePackLines(api.bot), ok: true };

    case "auth":
      return { lines: authLines(api.bot), ok: true };

    case "path":
      return { lines: pathLines(api.bot), ok: true };

    case "help":
      return { lines: HELP_LINES, ok: true };

    default:
      return {
        lines: [
          `Unknown command "${rawName}". Type "help" for the command list,`,
          `or use: say ${rawName} ${args.join(" ")}`.trim(),
        ],
        ok: false,
      };
  }
}

function withPromise(promise: Promise<unknown>, what: string): CommandResult {
  promise.catch((err: unknown) => {
    void err;
    void what;
  });
  return { lines: [`Connecting (${what})...`], ok: true };
}

function inventoryLines(bot: Bot): string[] {
  const world = bot.world;
  if (!world) return ["Not connected."];
  const window = world.windows.get(0) ?? world.activeWindow;
  if (!window || window.slots.length === 0) {
    return ["Inventory not received yet (window 0 empty)."];
  }
  const lines: string[] = ["Inventory (slot: amount x item):"];
  window.slots.forEach((slot, index) => {
    if (!slot) return;
    const name =
      slot.components.customName ??
      slot.components.name ??
      slot.components.model ??
      `item#${slot.itemId}`;
    const extras = slot.components.lore?.length ? ` — ${slot.components.lore[0]}` : "";
    lines.push(`  [${index}] ${slot.count} x ${name}${extras}`);
  });
  if (lines.length === 1) lines.push("  (all slots empty)");
  return lines;
}

function statusLines(bot: Bot): string[] {
  const snapshot = bot.snapshot();
  const conn = snapshot.connection;
  const pack = snapshot.resourcePack;
  const auth = snapshot.auth;
  return [
    `activity     : ${snapshot.activity}`,
    conn
      ? `connection   : ${conn.phase} via ${conn.transport} to ${conn.endpoint} ` +
          `(protocol ${conn.protocol}/${conn.version}${conn.encrypted ? ", encrypted" : ""})`
      : "connection   : not connected",
    snapshot.serverStatus
      ? `server       : ${snapshot.serverStatus.versionName} protocol ${snapshot.serverStatus.protocol}, ` +
          `${snapshot.serverStatus.playersOnline}/${snapshot.serverStatus.playersMax} players, ` +
          `${snapshot.serverStatus.latencyMs}ms`
      : "server       : status not queried yet",
    `position     : ${snapshot.player.x} ${snapshot.player.y} ${snapshot.player.z} ` +
      `(yaw ${snapshot.player.yaw}), dimension ${snapshot.player.dimension || "?"}`,
    `health       : ${snapshot.player.health}/20, food ${snapshot.player.food}/20, ` +
      `${snapshot.player.alive ? "alive" : "DEAD"}, gamemode ${snapshot.player.gamemode}`,
    `world        : ${snapshot.world.chunksLoaded} chunks, ${snapshot.world.entityCount} entities, ` +
      `${snapshot.world.players.length} players in tab list, ` +
      `${snapshot.world.registryLoaded ? "block registry loaded" : "block registry missing"}`,
    `navigation   : ${snapshot.navigation.hasPath ? `pathing (${snapshot.navigation.pathIndex}/${snapshot.navigation.pathLength})` : "idle"}` +
      (snapshot.navigation.following ? `, following ${snapshot.navigation.following}` : ""),
    `resource pack: ${pack.phase}${pack.url ? ` ${pack.url}` : ""}` +
      `${pack.required ? " (REQUIRED)" : ""}${pack.lastError ? ` — ${pack.lastError}` : ""}`,
    `auth         : ${auth.status}, attempts=${auth.attempts}, ` +
      `${auth.hasPassword ? "password configured" : "NO PASSWORD CONFIGURED"}` +
      (auth.guiOpen ? `, GUI open "${auth.guiTitle}"` : ""),
    snapshot.stats.lastError ? `last error   : ${snapshot.stats.lastError}` : "last error   : none",
  ];
}

function playerLines(bot: Bot): string[] {
  const snapshot = bot.snapshot();
  if (snapshot.world.players.length === 0) return ["Tab list is empty."];
  const lines = [`Players online (${snapshot.world.players.length}):`];
  for (const player of snapshot.world.players) {
    const gamemodes = ["survival", "creative", "adventure", "spectator"];
    const mode = typeof player.gamemode === "number" ? (gamemodes[player.gamemode] ?? "?") : "?";
    lines.push(
      `  ${player.name ?? "(unknown)"} — ${player.ping ?? "?"}ms, ${mode}` +
        `${player.listed === false ? ", hidden" : ""}`,
    );
  }
  const nearbyPlayers = snapshot.world.nearby.filter((e) => e.kind === "player");
  if (nearbyPlayers.length > 0) {
    lines.push("Nearby players:");
    for (const entity of nearbyPlayers) {
      lines.push(`  ${entity.name} — ${entity.distance}m at ${entity.x} ${entity.y} ${entity.z}`);
    }
  }
  return lines;
}

function resourcePackLines(bot: Bot): string[] {
  const state = bot.resourcePack.state;
  if (!state.request) return ["No resource-pack request received on this connection."];
  const lines = [
    `phase   : ${state.phase}`,
    `source  : ${state.request.source}`,
    `url     : ${state.request.url}`,
    `hash    : ${state.request.hash || "(none provided)"}`,
    `required: ${state.request.required ? "yes (server will kick on decline)" : "no"}`,
    `policy  : ${bot.config.resourcePack.policy}`,
    `download: ${state.downloadedBytes} bytes, verified=${state.verified}, cached=${state.cached}`,
  ];
  if (state.lastError) lines.push(`error   : ${state.lastError}`);
  for (const response of state.responses) {
    lines.push(`response: ${statusName(response.status)} — ${response.note}`);
  }
  lines.push("history:");
  for (const event of state.history.slice(-6)) {
    lines.push(`  ${new Date(event.at).toLocaleTimeString()} ${event.event}${event.detail ? ` — ${event.detail}` : ""}`);
  }
  return lines;
}

function authLines(bot: Bot): string[] {
  const state = bot.auth.state;
  const config = bot.config;
  const lines = [
    `status  : ${state.status}`,
    `attempts: ${state.attempts}`,
    `password: ${config.credentials.password ? "configured (redacted)" : "NOT CONFIGURED"}`,
    `commands: login="${config.credentials.loginCommand}" ` +
      `register="${config.credentials.registerCommand}"`,
    `gui auth: ${config.guiAuth.enabled ? "enabled" : "disabled"}` +
      (config.guiAuth.slots.length ? ` (slots ${config.guiAuth.slots.join(",")})` : " (auto-detect)"),
  ];
  if (state.prompt) {
    lines.push(`prompt  : ${state.prompt.intent} via ${state.prompt.source}`);
  }
  if (state.guiWindow) {
    lines.push(`gui     : window ${state.guiWindow.windowId} "${state.guiWindow.title}" ` +
      `with ${Object.keys(state.guiWindow.items).length} filled slot(s)`);
    for (const [slot, label] of Object.entries(state.guiWindow.items).slice(0, 10)) {
      lines.push(`          slot ${slot}: ${label}`);
    }
  }
  if (state.lastError) lines.push(`last err: ${state.lastError}`);
  lines.push("history:");
  for (const event of state.history.slice(-6)) {
    lines.push(`  ${new Date(event.at).toLocaleTimeString()} ${event.event}${event.detail ? ` — ${event.detail}` : ""}`);
  }
  return lines;
}

function pathLines(bot: Bot): string[] {
  const snapshot = bot.snapshot();
  const nav = snapshot.navigation;
  return [
    `activity : ${snapshot.activity}`,
    `goal     : ${nav.goal ? `${nav.goal.x} ${nav.goal.y} ${nav.goal.z}` : "(none)"}`,
    `path     : ${nav.hasPath ? `${nav.pathIndex}/${nav.pathLength} steps` : "none"}`,
    `following: ${nav.following ?? "(not following)"}`,
    `last run : ${nav.lastPathResult ?? "(no path computed yet)"}`,
    `registry : ${snapshot.world.registryLoaded ? "block registry loaded" : "geometry-only mode"}`,
  ];
}
