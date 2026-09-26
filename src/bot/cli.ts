/**
 * Termux/Node console dashboard + command REPL.
 *
 * Run:  bun src/bot/cli.ts        (or: node --experimental-strip-types)
 * Env:  MC_HOST, MC_PORT, MC_USERNAME, MC_PASSWORD, MC_LOGIN_COMMAND,
 *       MC_REGISTER_COMMAND, RESOURCE_PACK_POLICY, MC_ACCESS_TOKEN, ...
 *
 * The dashboard redraws once per second showing connection state, coordinates,
 * health/hunger, nearby players/entities, resource-pack state, authentication
 * state and recent chat/logs — everything the prompt asks to observe. Type
 * `help` for commands.
 *
 * Example (real server, exactly as configured by default):
 *   MC_PASSWORD=secret bun src/bot/cli.ts
 *   > connect
 *   > goto 100 64 -30
 */
import readline from "node:readline";
import { Bot } from "./core/bot";
import { BotLogger, type LogEntry } from "./core/logger";
import { loadConfig, validateConfig, describeConfig } from "./core/config";
import { runCommand } from "./core/commands";
import { TcpTransport } from "./transport/nodeTcp";
import { SimulatedTransport } from "./transport/simulated";
import { forgetSecrets } from "./core/redact";

const useSim = process.argv.includes("--sim");
const quiet = process.argv.includes("--quiet");

const config = loadConfig(process.env);
const logger = new BotLogger({ capacity: 600, minLevel: quiet ? "info" : "debug" });

if (!useSim) {
  logger.subscribe((entry) => {
    if (entry.level === "debug") return;
    process.stdout.write(`${formatEntry(entry, false)}\r\n`);
  });
}

for (const problem of validateConfig(config)) {
  logger.error("config", problem);
}

const bot = new Bot({
  config,
  logger,
  createTransport: (cfg) =>
    useSim
      ? new SimulatedTransport({
          host: cfg.host,
          port: cfg.port,
          scenario: "gui-login",
          logger,
        })
      : new TcpTransport({
          host: cfg.host,
          port: cfg.port,
          resolveSrv: cfg.resolveSrv,
          connectTimeoutMs: cfg.timeouts.connectMs,
          logger,
        }),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line) => {
  const input = line.trim();
  if (!input) return;
  if (input === "quit" || input === "exit") {
    bot.disconnect("console exit");
    shutdown(0);
    return;
  }
  const result = runCommand(input, {
    bot,
    connect: async () => {
      await bot.connect();
    },
    disconnect: (reason) => bot.disconnect(reason),
  });
  for (const lineText of result.lines) {
    process.stdout.write(`${result.ok ? "  " : "! "} ${lineText}\r\n`);
  }
  if (!result.ok) process.stdout.write("  (command failed)\r\n");
});

let renderTimer: ReturnType<typeof setInterval> | null = null;

function formatEntry(entry: LogEntry, color: boolean): string {
  const time = new Date(entry.at).toLocaleTimeString();
  const level = entry.level.toUpperCase().padEnd(5);
  if (!color) return `[${time}] ${level} ${entry.scope.padEnd(11)} ${entry.message}`;
  const palette: Record<string, string> = {
    debug: "\x1b[90m",
    info: "\x1b[36m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
  };
  return `${palette[entry.level] ?? ""}[${time}] ${level} ${entry.scope.padEnd(11)} ${entry.message}\x1b[0m`;
}

function heart(value: number, max: number, length = 10): string {
  const filled = Math.max(0, Math.min(length, Math.round((value / max) * length)));
  return "█".repeat(filled) + "░".repeat(length - filled);
}

function render(): void {
  const snapshot = bot.snapshot();
  const conn = snapshot.connection;
  const pack = snapshot.resourcePack;
  const auth = snapshot.auth;
  const width = 78;
  const bar = "─".repeat(width);
  const lines: string[] = [];

  lines.push(`\x1b[1mPANCAKESMP HEADLESS BOT${useSim ? " [SIMULATED]" : ""}\x1b[0m  ${bar}`);
  lines.push(
    `state ${colorActivity(snapshot.activity)}   target ${config.host}:${config.port}   ` +
      `protocol ${conn?.protocol ?? config.protocolVersion} (${conn?.version ?? config.versionName})`,
  );
  lines.push(
    conn
      ? `phase ${conn.phase}   transport ${conn.transport}   endpoint ${conn.endpoint}   ` +
          `${conn.encrypted ? "encrypted" : "plaintext"}   threshold ${conn.compressionThreshold}`
      : "phase idle   (type `connect` to start)",
  );
  lines.push(bar);

  const p = snapshot.player;
  lines.push(
    `pos ${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}   yaw ${p.yaw}   ${p.alive ? "alive" : "\x1b[31mDEAD\x1b[0m"}   ` +
      `gm ${p.gamemode}   dim ${p.dimension || "?"}`,
  );
  lines.push(
    `hp ${heart(p.health, 20)} ${p.health.toFixed(1)}   food ${heart(p.food, 20)} ${p.food}   ` +
      `chunks ${snapshot.world.chunksLoaded}   entities ${snapshot.world.entityCount}   items ${snapshot.world.collectedItems}`,
  );
  const nav = snapshot.navigation;
  lines.push(
    `nav ${snapshot.activity === "pathing" ? `step ${nav.pathIndex}/${nav.pathLength}` : "idle"}` +
      `${nav.following ? `  following ${nav.following}` : ""}` +
      `${nav.goal ? `  goal ${fmt(nav.goal.x)} ${fmt(nav.goal.y)} ${fmt(nav.goal.z)}` : ""}` +
      `${snapshot.world.registryLoaded ? "  registry:on" : "  registry:off"}`,
  );
  lines.push(bar);

  lines.push(
    `pack ${pack.phase}${pack.required ? " (REQUIRED)" : ""}   policy ${config.resourcePack.policy}` +
      `${pack.url ? `\n     ${pack.url}` : ""}${pack.lastError ? `\n     \x1b[31m${pack.lastError}\x1b[0m` : ""}`,
  );
  lines.push(
    `auth ${auth.status}  attempts ${auth.attempts}  ` +
      `${auth.hasPassword ? "password:yes" : "\x1b[31mpassword:NO\x1b[0m"}` +
      `${auth.guiOpen ? `  gui:"${auth.guiTitle}"` : ""}` +
      `${auth.promptSource ? `  prompt:${auth.promptIntent}/${auth.promptSource}` : ""}`,
  );
  lines.push(bar);

  const players = snapshot.world.players;
  lines.push(`players ${players.length}: ${players.slice(0, 8).map((pl) => pl.name ?? pl.uuid.slice(0, 8)).join(", ") || "-"}`);
  const nearby = snapshot.world.nearby.slice(0, 6);
  lines.push(
    `nearby  ${nearby.length ? nearby.map((e) => `${e.name}@${e.distance}m`).join(", ") : "-"}`,
  );
  lines.push(bar);

  lines.push("chat (recent):");
  for (const line of snapshot.world.recentChat.slice(-6)) {
    lines.push(`  [${line.source}] ${truncate(line.text, width - 12)}`);
  }
  lines.push(bar);
  lines.push("logs (recent):");
  for (const entry of bot.logs().slice(-10)) {
    lines.push(`  ${formatEntry(entry, true)}`);
  }
  lines.push(bar);
  lines.push("commands: connect disconnect say goto follow stop inventory status players resourcepack auth help quit");

  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n");
}

function colorActivity(activity: string): string {
  const colors: Record<string, string> = {
    disconnected: "\x1b[90m",
    connecting: "\x1b[33m",
    idle: "\x1b[32m",
    pathing: "\x1b[36m",
    following: "\x1b[36m",
    combat: "\x1b[31m",
    dead: "\x1b[31m",
  };
  return `${colors[activity] ?? ""}${activity}\x1b[0m`;
}

function fmt(value: number): string {
  return value.toFixed(1);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shutdown(code: number): void {
  if (renderTimer) clearInterval(renderTimer);
  try {
    bot.disconnect("shutdown");
  } catch {
    /* ignore */
  }
  forgetSecrets();
  process.exit(code);
}

process.on("SIGINT", () => {
  process.stdout.write("\r\nShutting down...\r\n");
  shutdown(0);
});

async function main(): Promise<void> {
  logger.info(
    "cli",
    `Bot console starting. Target ${config.host}:${config.port} ` +
      `(versionMode=${config.versionMode}, policy=${config.resourcePack.policy}, ` +
      `authMode=${config.authMode}).`,
  );
  logger.debug("cli", `Config: ${JSON.stringify(describeConfig(config))}`);
  logger.info("cli", 'Type "help" for commands. "connect" joins the server.');

  renderTimer = setInterval(render, 1000);
  render();

  if (!useSim && process.argv.includes("--connect")) {
    await bot.connect().catch(() => {
      /* logged */
    });
  }
}

void main();
