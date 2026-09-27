/**
 * Wire protocol shared by the browser bridge client (`src/lib/remoteBot.ts`)
 * and the backend bridge (`src/server/*`).
 *
 * This file is TYPES ONLY — nothing here executes — so the browser bundle never
 * pulls in server code and the backend never pulls in React code. Imports use
 * relative paths (`../bot/...`) so both the app tsconfig and the server
 * tsconfig can resolve them without aliases.
 */
import type { BotSnapshot } from "../bot/core/bot";
import type { LogEntry } from "../bot/core/logger";

export type { BotSnapshot, LogEntry };

/** Connection state of the phone <-> backend link (not the Minecraft link). */
export type BridgeStatus = "disabled" | "connecting" | "online" | "unauthorized" | "offline";

/** Non-secret settings the backend reports back. `hasPassword` is a flag only. */
export interface BackendSettings {
  username: string;
  hasPassword: boolean;
  loginCommand: string;
  registerCommand: string;
  resourcePackPolicy: string;
  antiIdle: boolean;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: number;
}

/** Settings the dashboard may push. The password travels separately and once. */
export interface SettingsPush {
  username?: string;
  loginCommand?: string;
  registerCommand?: string;
  resourcePackPolicy?: string;
  antiIdle?: boolean;
  reconnectEnabled?: boolean;
  reconnectMaxAttempts?: number;
}

export interface CommandOutcome {
  ok: boolean;
  lines: string[];
}

/* ------------------------------------------------------------ server -> phone */

export type BridgeMessage =
  | {
      type: "hello";
      /** Backend version string. */
      version: string;
      /** Configured Minecraft target, always host:port as configured. */
      target: string;
      settings: BackendSettings;
      config: Record<string, unknown>;
      snapshot: BotSnapshot;
      logs: LogEntry[];
      at: number;
    }
  | { type: "snapshot"; snapshot: BotSnapshot }
  | { type: "log"; entries: LogEntry[] }
  | { type: "settings"; settings: BackendSettings }
  | { type: "commandResult"; id: string; ok: boolean; lines: string[] }
  | { type: "pong"; at: number }
  | { type: "error"; message: string };

/* ------------------------------------------------------------ phone -> server */

export type BridgeRequest =
  | { type: "command"; id: string; input: string }
  | { type: "ping"; at?: number };

/** Backend version, shown in the dashboard's connection card. */
export const BRIDGE_VERSION = "1.0.0";
