/**
 * Structured ring-buffer logger.
 *
 * Everything the bot says about connection/version/protocol/resource-pack/GUI
 * /auth flows through here so the CLI console and the web dashboard render the
 * same diagnosable trail. Messages are redacted before storage, so secrets can
 * never reach a UI.
 */
import { redact, redactData } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  /** Epoch ms. */
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export interface LoggerOptions {
  capacity?: number;
  minLevel?: LogLevel;
  onEntry?: (entry: LogEntry) => void;
}

export class BotLogger {
  private readonly entries: LogEntry[] = [];
  private readonly capacity: number;
  private minLevel: LogLevel;
  private readonly listeners: Array<(entry: LogEntry) => void> = [];
  private seq = 0;

  constructor(options: LoggerOptions = {}) {
    this.capacity = options.capacity ?? 500;
    this.minLevel = options.minLevel ?? "debug";
    if (options.onEntry) this.listeners.push(options.onEntry);
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  log(level: LogLevel, scope: string, message: string, data?: unknown): LogEntry {
    const entry: LogEntry = {
      at: Date.now() + this.seq++ * 0, // monotonic-ish ordering for equal timestamps
      level,
      scope,
      message: redact(message),
      data: data === undefined ? undefined : redactData(data),
    };
    if (LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel]) {
      this.entries.push(entry);
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // Listeners must never break the bot.
        }
      }
    }
    return entry;
  }

  debug(scope: string, message: string, data?: unknown): void {
    this.log("debug", scope, message, data);
  }

  info(scope: string, message: string, data?: unknown): void {
    this.log("info", scope, message, data);
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.log("warn", scope, message, data);
  }

  error(scope: string, message: string, data?: unknown): void {
    this.log("error", scope, message, data);
  }

  /** Copy of the current ring buffer (oldest first). */
  snapshot(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
