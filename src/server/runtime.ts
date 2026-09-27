/**
 * BotRuntime — the single server-side owner of the real Minecraft connection.
 *
 * The phone never talks to Minecraft. It sends validated commands through the
 * authenticated bridge and receives snapshots + logs back. Because the runtime
 * is a process-level singleton:
 *
 *   - the bot keeps running when every browser closes (the WebSocket is only a
 *     control/monitoring connection),
 *   - refreshing the browser or opening several tabs never creates a second
 *     Minecraft connection,
 *   - the configured target stays exactly `pancakesmp.kinetic.host:25565`
 *     (SRV resolution inside TcpTransport is internal and logged, the handshake
 *     always announces the configured host/port).
 *
 * It reuses the existing engine unchanged: Bot, TcpTransport, runCommand,
 * BotLogger, config loading and the redaction layer. No protocol code is
 * duplicated or rewritten here.
 */
import { Bot, type BotSnapshot } from "../bot/core/bot";
import { BotLogger, type LogEntry } from "../bot/core/logger";
import {
  loadConfig,
  mergeConfig,
  validateConfig,
  describeConfig,
  type BotConfig,
  type EnvLike,
} from "../bot/core/config";
import { runCommand } from "../bot/core/commands";
import { TcpTransport } from "../bot/transport/nodeTcp";
import type { Transport } from "../bot/transport/transport";
import { registerSecret } from "../bot/core/redact";
import type { BackendSettings, BridgeMessage, CommandOutcome, SettingsPush } from "../lib/bridgeProtocol";

const MAX_INPUT_LENGTH = 240;
const MAX_FIELD_LENGTH = 160;
const MAX_PASSWORD_LENGTH = 256;
const LOG_BUFFER_LIMIT = 400;

const RESOURCE_PACK_POLICIES = ["accept", "decline", "required-only", "download-and-accept"];

/** Sliding token bucket. `take` returns 0 when allowed, else ms until ready. */
class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  readonly capacity: number;
  readonly refillPerSec: number;

  constructor(capacity: number, refillPerSec: number, now: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(now: number, cost = 1): number {
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.updatedAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSec);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return 0;
    }
    return Math.ceil(((cost - this.tokens) / this.refillPerSec) * 1000);
  }
}

/**
 * Per-caller and global rate limiting for commands. Chat verbs get a tighter
 * bucket than read-only commands so a stuck finger cannot spam the server.
 */
class RateLimiter {
  private readonly buckets = new Map<string, { command: TokenBucket; chat: TokenBucket }>();
  private readonly global: TokenBucket;

  constructor(now: number) {
    this.global = new TokenBucket(60, 6, now);
  }

  take(key: string, now: number, isChat: boolean): number {
    const globalWait = this.global.take(now, 1);
    if (globalWait > 0) return globalWait;

    if (this.buckets.size > 256) this.buckets.clear();
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { command: new TokenBucket(12, 1.2, now), chat: new TokenBucket(6, 0.4, now) };
      this.buckets.set(key, entry);
    }
    return isChat ? entry.chat.take(now, 1) : entry.command.take(now, 1);
  }
}

function coerceString(value: unknown, fallback: string, maxLength = MAX_FIELD_LENGTH): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLength);
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function coerceInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

/** Normalise untrusted command text; returns null when nothing usable remains. */
function sanitizeCommand(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INPUT_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function isChatCommand(input: string): boolean {
  return /^say(\s|$)/i.test(input);
}

export interface BotRuntimeOptions {
  /** Environment map used for the initial config (process.env in production). */
  env: EnvLike;
  /** Connect to Minecraft as soon as the bridge boots (headless operation). */
  autoConnect?: boolean;
}

export class BotRuntime {
  readonly logger: BotLogger;
  /** Immutable view of what the transport is configured to announce. */
  readonly target: string;

  private bot: Bot;
  private readonly options: BotRuntimeOptions;
  private readonly subscribers = new Set<(message: BridgeMessage) => void>();
  private readonly limiter = new RateLimiter(Date.now());
  private readonly logBuffer: LogEntry[] = [];
  private pendingLogs: LogEntry[] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval>;
  private startedAt = Date.now();

  constructor(options: BotRuntimeOptions) {
    this.options = options;
    this.logger = new BotLogger({ capacity: 800, minLevel: "debug" });
    this.bot = this.makeBot(loadConfig(options.env));
    this.target = `${this.bot.config.host}:${this.bot.config.port}`;

    this.logger.subscribe((entry) => this.queueLog(entry));
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000);
    // Tests and short-lived processes must be able to exit.
    (this.snapshotTimer as unknown as { unref?: () => void }).unref?.();

    for (const problem of validateConfig(this.bot.config)) {
      this.logger.error("config", problem);
    }
    this.logger.info(
      "bridge",
      `Runtime ready. Configured target ${this.target} ` +
        `(policy=${this.bot.config.resourcePack.policy}, autoIdle=${this.bot.config.antiIdle.enabled}).`,
    );

    if (options.autoConnect) {
      void this.bot.connect().catch(() => {
        /* the engine already logged the real error */
      });
    }
  }

  private makeBot(config: BotConfig): Bot {
    return new Bot({
      config,
      logger: this.logger,
      createTransport: (cfg): Transport =>
        new TcpTransport({
          host: cfg.host,
          port: cfg.port,
          resolveSrv: cfg.resolveSrv,
          connectTimeoutMs: cfg.timeouts.connectMs,
          logger: this.logger,
        }),
    });
  }

  /* ------------------------------------------------------------- lifecycle */

  stop(): void {
    clearInterval(this.snapshotTimer);
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    this.bot.disconnect("bridge shutdown");
  }

  /* ----------------------------------------------------- subscribers/fanout */

  subscribe(listener: (message: BridgeMessage) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private broadcast(message: BridgeMessage): void {
    for (const listener of this.subscribers) {
      try {
        listener(message);
      } catch {
        // A broken transport must never break the bot.
      }
    }
  }

  private queueLog(entry: LogEntry): void {
    this.logBuffer.push(entry);
    if (this.logBuffer.length > LOG_BUFFER_LIMIT) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_LIMIT);
    }
    this.pendingLogs.push(entry);
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      const entries = this.pendingLogs;
      this.pendingLogs = [];
      if (entries.length > 0) this.broadcast({ type: "log", entries });
    }, 120);
    (this.logFlushTimer as unknown as { unref?: () => void }).unref?.();
  }

  private broadcastSnapshot(): void {
    if (this.subscribers.size === 0) return;
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
  }

  /** Recent logs so a freshly connected phone immediately shows history. */
  recentLogs(limit = 200): LogEntry[] {
    return this.logBuffer.slice(-limit);
  }

  /* -------------------------------------------------------------- read APIs */

  snapshot(): BotSnapshot {
    return this.bot.snapshot();
  }

  settingsView(): BackendSettings {
    const config = this.bot.config;
    return {
      username: config.credentials.username,
      hasPassword: Boolean(config.credentials.password),
      loginCommand: config.credentials.loginCommand,
      registerCommand: config.credentials.registerCommand,
      resourcePackPolicy: config.resourcePack.policy,
      antiIdle: config.antiIdle.enabled,
      reconnectEnabled: config.reconnect.enabled,
      reconnectMaxAttempts: config.reconnect.maxAttempts,
    };
  }

  /** Redacted config view (never contains secrets). */
  configView(): Record<string, unknown> {
    return describeConfig(this.bot.config);
  }

  /* ---------------------------------------------------------------- commands */

  /**
   * Run a dashboard command on the real bot.
   *
   * Server-side validation happens in two layers: the sanitizer here caps
   * length/control characters, and `runCommand` only understands the documented
   * verb list — anything else is rejected. There is no shell execution path.
   */
  async command(raw: unknown, callerKey: string): Promise<CommandOutcome> {
    const input = sanitizeCommand(raw);
    if (input === null) {
      return { ok: false, lines: ["Invalid command."] };
    }

    const wait = this.limiter.take(callerKey, Date.now(), isChatCommand(input));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      this.logger.warn("bridge", `Rate limit for ${callerKey}; rejected a command (${seconds}s).`);
      return { ok: false, lines: [`Rate limited — try again in ${seconds}s.`] };
    }

    const result = runCommand(input, {
      bot: this.bot,
      connect: () => this.bot.connect(),
      disconnect: (reason) => this.bot.disconnect(reason),
    });
    for (const line of result.lines) {
      if (result.ok) this.logger.info("console", line);
      else this.logger.warn("console", line);
    }
    return { ok: result.ok, lines: result.lines };
  }

  /* ---------------------------------------------------------------- settings */

  /**
   * Apply dashboard settings. The password (when supplied) is merged into the
   * in-memory config and registered with the redaction layer; it is never
   * returned to any client and never logged. Returns validation problems.
   */
  applySettings(raw: SettingsPush, password?: string): { problems: string[]; settings: BackendSettings } {
    const current = this.bot.config;
    const policy = RESOURCE_PACK_POLICIES.includes(String(raw.resourcePackPolicy))
      ? String(raw.resourcePackPolicy)
      : current.resourcePack.policy;
    if (raw.resourcePackPolicy !== undefined && policy !== raw.resourcePackPolicy) {
      this.logger.warn("config", `Ignored unknown resource-pack policy "${String(raw.resourcePackPolicy)}".`);
    }

    const secret = typeof password === "string" && password.length > 0 ? password.slice(0, MAX_PASSWORD_LENGTH) : undefined;
    if (secret) registerSecret(secret);

    const next = mergeConfig(current, {
      credentials: {
        ...current.credentials,
        username: coerceString(raw.username, current.credentials.username, 32),
        ...(secret ? { password: secret, password2: secret } : {}),
        loginCommand: coerceString(raw.loginCommand, current.credentials.loginCommand),
        registerCommand: coerceString(raw.registerCommand, current.credentials.registerCommand),
      },
      resourcePack: { ...current.resourcePack, policy: policy as BotConfig["resourcePack"]["policy"] },
      antiIdle: { ...current.antiIdle, enabled: coerceBoolean(raw.antiIdle, current.antiIdle.enabled) },
      reconnect: {
        ...current.reconnect,
        enabled: coerceBoolean(raw.reconnectEnabled, current.reconnect.enabled),
        maxAttempts: coerceInt(raw.reconnectMaxAttempts, current.reconnect.maxAttempts, 1, 50),
      },
    });

    const wasConnected = this.bot.activity !== "disconnected";
    this.bot.disconnect("settings changed");
    this.bot = this.makeBot(next);
    if (wasConnected) {
      void this.bot.connect().catch(() => {
        /* the engine already logged the real error */
      });
    }

    const problems = validateConfig(next);
    for (const problem of problems) this.logger.error("config", problem);
    this.logger.info("bot", "Bridge settings applied.");

    const settings = this.settingsView();
    this.broadcast({ type: "settings", settings });
    return { problems, settings };
  }

  /* ------------------------------------------------------------------ info */

  stats(): { uptimeMs: number; clients: number; activity: string; target: string } {
    return {
      uptimeMs: Date.now() - this.startedAt,
      clients: this.subscribers.size,
      activity: this.bot.activity,
      target: this.target,
    };
  }

  /** Used by the self-test to reset uptime reporting. */
  markStarted(at = Date.now()): void {
    this.startedAt = at;
  }
}
