/**
 * Browser-side bot singleton.
 *
 * Browsers cannot open raw TCP sockets, so the web dashboard runs the bot
 * against the SimulatedTransport (the scripted protocol-774 server used for
 * end-to-end testing). The Termux CLI (`src/bot/cli.ts`) is the path that
 * talks to the real PancakeSMP server over TCP. Everything else — protocol
 * stack, auth flow, resource-pack handling, pathfinding, commands — is the
 * exact same code in both.
 *
 * Secrets entered in the dashboard live only in memory and are registered
 * with the redaction layer; they are never persisted to Convex.
 */
import { Bot } from "@/bot/core/bot";
import { BotLogger, type LogEntry } from "@/bot/core/logger";
import { loadConfig, mergeConfig, validateConfig, type BotConfig } from "@/bot/core/config";
import { SimulatedTransport } from "@/bot/transport/simulated";

export interface DashboardSettings {
  username: string;
  hasPassword: boolean;
  loginCommand: string;
  registerCommand: string;
  resourcePackPolicy: string;
  antiIdle: boolean;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: number;
  /** Bumped on every save so consumers can react to changes. */
  updateSeq: number;
}

let logger: BotLogger | null = null;
let bot: Bot | null = null;

function makeTransport(cfg: BotConfig): SimulatedTransport {
  return new SimulatedTransport({
    host: cfg.host,
    port: cfg.port,
    scenario: "gui-login",
  });
}

export function getBot(): Bot {
  if (bot) return bot;
  const config = loadConfig({}, { host: "pancakesmp.kinetic.host", port: 25565 });
  logger = new BotLogger({ capacity: 600, minLevel: "debug" });
  bot = new Bot({
    config,
    logger,
    createTransport: makeTransport,
  });
  return bot;
}

export function getLogger(): BotLogger {
  return getBot().logger;
}

/**
 * Apply dashboard settings to the live bot. The typed password (if any) is
 * merged into the in-memory config and registered with the redaction layer;
 * it is never written anywhere persistent. The bot is rebuilt so the new
 * config takes effect cleanly, reconnecting first if it was running.
 */
export function applySettings(settings: DashboardSettings, password?: string): string[] {
  const current = getBot();
  const wasConnected = current.activity !== "disconnected";
  current.disconnect("settings changed");

  const next = mergeConfig(current.config, {
    credentials: {
      ...current.config.credentials,
      username: settings.username || "PancakeBot",
      password:
        password !== undefined && password.length > 0
          ? password
          : current.config.credentials.password,
      password2:
        password !== undefined && password.length > 0
          ? password
          : current.config.credentials.password2,
      loginCommand: settings.loginCommand || "/login {password}",
      registerCommand: settings.registerCommand || "/register {password} {password2}",
    },
    resourcePack: {
      ...current.config.resourcePack,
      policy: settings.resourcePackPolicy as BotConfig["resourcePack"]["policy"],
    },
    antiIdle: { ...current.config.antiIdle, enabled: settings.antiIdle },
    reconnect: {
      ...current.config.reconnect,
      enabled: settings.reconnectEnabled,
      maxAttempts: settings.reconnectMaxAttempts,
    },
  });

  bot = new Bot({ config: next, logger: getLogger(), createTransport: makeTransport });
  if (wasConnected) void bot.connect().catch(() => undefined);

  const problems = validateConfig(next);
  const activeLogger = getLogger();
  for (const problem of problems) activeLogger.error("config", problem);
  activeLogger.info("bot", "Dashboard settings applied.");
  return problems;
}

/** Does the live bot already have a password configured? */
export function botHasPassword(): boolean {
  return getBot().config.credentials.password !== undefined;
}

export type { LogEntry };
