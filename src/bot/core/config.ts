/**
 * Bot configuration: defaults, environment-variable loading and merging.
 *
 * Secrets (password, token) are registered with the redaction layer the moment
 * they enter the process, and are never written into logs or persisted state.
 */
import { registerSecret } from "./redact";
import type { ResourcePackPolicy } from "./resourcePack";

export type VersionMode = "auto" | "fixed";
export type AuthMode = "offline" | "online";

export interface CredentialsConfig {
  /** In-game account name the bot logs in as. */
  username: string;
  /** Password used by chat/GUI authentication (never logged). */
  password?: string;
  /** Second password for register-style commands (never logged). */
  password2?: string;
  /** Command template, e.g. "/login {password}". */
  loginCommand: string;
  /** Command template, e.g. "/register {password} {password2}". */
  registerCommand: string;
}

export interface GuiAuthConfig {
  enabled: boolean;
  /** Delay before clicking, so plugins finish opening the window. */
  submitDelayMs: number;
  /** Explicit slot(s) to click; when empty the bot inspects item names. */
  slots: number[];
  /** Seconds to wait for an auth result before declaring timeout. */
  timeoutMs: number;
}

export interface ResourcePackConfig {
  policy: ResourcePackPolicy;
  /** Timeout for a single pack download. */
  timeoutMs: number;
  /** Refuse downloads larger than this. */
  maxBytes: number;
  /** Cache verified packs for the session. */
  cache: boolean;
}

export interface BotConfig {
  /** Target server. Never change the port from 25565 for this deployment. */
  host: string;
  port: number;
  /** Resolve _minecraft._tcp SRV records like a vanilla client does. */
  resolveSrv: boolean;
  /** Version handling: "auto" detects from the status ping, "fixed" uses the values below. */
  versionMode: VersionMode;
  protocolVersion: number;
  versionName: string;
  /** Connection behaviour. */
  authMode: AuthMode;
  /** Optional Mojang session token (only needed for online-mode servers). */
  accessToken?: string;
  credentials: CredentialsConfig;
  guiAuth: GuiAuthConfig;
  resourcePack: ResourcePackConfig;
  antiIdle: { enabled: boolean; intervalMs: number };
  reconnect: { enabled: boolean; delayMs: number; maxAttempts: number };
  /** Seconds to wait for status/login/configuration transitions. */
  timeouts: {
    connectMs: number;
    statusMs: number;
    loginMs: number;
    configurationMs: number;
    keepAliveMs: number;
  };
}

/**
 * Default configuration targets the PancakeSMP deployment exactly as
 * specified: host "pancakesmp.kinetic.host", port 25565.
 */
export const DEFAULT_CONFIG: BotConfig = {
  host: "pancakesmp.kinetic.host",
  port: 25565,
  resolveSrv: true,
  versionMode: "auto",
  protocolVersion: 774,
  versionName: "1.21.11",
  authMode: "offline",
  credentials: {
    username: "PancakeBot",
    loginCommand: "/login {password}",
    registerCommand: "/register {password} {password2}",
  },
  guiAuth: {
    enabled: true,
    submitDelayMs: 400,
    slots: [],
    timeoutMs: 15000,
  },
  resourcePack: {
    policy: "accept",
    timeoutMs: 30000,
    maxBytes: 64 * 1024 * 1024,
    cache: true,
  },
  antiIdle: { enabled: true, intervalMs: 45000 },
  reconnect: { enabled: true, delayMs: 3000, maxAttempts: 10 },
  timeouts: {
    connectMs: 10000,
    statusMs: 10000,
    loginMs: 20000,
    configurationMs: 30000,
    keepAliveMs: 30000,
  },
};

export type EnvLike = Record<string, string | undefined>;

function envString(env: EnvLike, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function envInt(env: EnvLike, keys: string[]): number | undefined {
  const raw = envString(env, ...keys);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const RESOURCE_PACK_POLICIES: ResourcePackPolicy[] = [
  "accept",
  "decline",
  "required-only",
  "download-and-accept",
];

/**
 * Build config from an environment map (Node/Termux) with optional patch.
 * Unknown values fall back to defaults rather than throwing; bad enums are
 * reported by the caller through the logger.
 */
export function loadConfig(env: EnvLike = {}, patch: Partial<BotConfig> = {}): BotConfig {
  const base: BotConfig = structuredClone(DEFAULT_CONFIG);

  const host = envString(env, "MC_HOST", "SERVER_HOST");
  if (host) base.host = host;
  const port = envInt(env, ["MC_PORT", "SERVER_PORT"]);
  if (port !== undefined) base.port = port;

  const protocol = envInt(env, ["MC_PROTOCOL", "PROTOCOL_VERSION"]);
  if (protocol !== undefined) {
    base.protocolVersion = protocol;
    base.versionMode = "fixed";
  }
  const versionName = envString(env, "MC_VERSION");
  if (versionName) {
    base.versionName = versionName;
    if (!envString(env, "MC_PROTOCOL")) base.versionMode = "fixed";
  }
  const versionMode = envString(env, "MC_VERSION_MODE");
  if (versionMode === "auto" || versionMode === "fixed") base.versionMode = versionMode;

  const username = envString(env, "MC_USERNAME", "BOT_USERNAME");
  if (username) base.credentials.username = username;
  const password = envString(env, "MC_PASSWORD", "BOT_PASSWORD");
  if (password) base.credentials.password = password;
  const password2 = envString(env, "MC_PASSWORD2", "BOT_PASSWORD2");
  if (password2) base.credentials.password2 = password2;
  const loginCommand = envString(env, "MC_LOGIN_COMMAND");
  if (loginCommand) base.credentials.loginCommand = loginCommand;
  const registerCommand = envString(env, "MC_REGISTER_COMMAND");
  if (registerCommand) base.credentials.registerCommand = registerCommand;

  const authMode = envString(env, "MC_AUTH_MODE");
  if (authMode === "offline" || authMode === "online") base.authMode = authMode;
  const token = envString(env, "MC_ACCESS_TOKEN", "MINECRAFT_TOKEN");
  if (token) {
    base.accessToken = token;
    base.authMode = "online";
  }

  const policy = envString(env, "RESOURCE_PACK_POLICY", "MC_RESOURCE_PACK");
  if (policy && RESOURCE_PACK_POLICIES.includes(policy as ResourcePackPolicy)) {
    base.resourcePack.policy = policy as ResourcePackPolicy;
  }
  const packTimeout = envInt(env, ["RESOURCE_PACK_TIMEOUT_MS"]);
  if (packTimeout !== undefined) base.resourcePack.timeoutMs = packTimeout;
  const packMax = envInt(env, ["RESOURCE_PACK_MAX_BYTES"]);
  if (packMax !== undefined) base.resourcePack.maxBytes = packMax;

  const srv = envString(env, "MC_RESOLVE_SRV");
  if (srv === "0" || srv === "false") base.resolveSrv = false;
  if (srv === "1" || srv === "true") base.resolveSrv = true;

  const slotsRaw = envString(env, "MC_GUI_SLOTS");
  if (slotsRaw) {
    base.guiAuth.slots = slotsRaw
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  }

  const merged = mergeConfig(base, patch);
  // Register secrets immediately so nothing can log them later.
  registerSecret(merged.credentials.password);
  registerSecret(merged.credentials.password2);
  registerSecret(merged.accessToken);
  return merged;
}

/** Shallow-ish merge of a partial patch over an existing config. */
export function mergeConfig(base: BotConfig, patch: Partial<BotConfig>): BotConfig {
  const next: BotConfig = {
    ...base,
    ...patch,
    credentials: { ...base.credentials, ...(patch.credentials ?? {}) },
    guiAuth: { ...base.guiAuth, ...(patch.guiAuth ?? {}) },
    resourcePack: { ...base.resourcePack, ...(patch.resourcePack ?? {}) },
    antiIdle: { ...base.antiIdle, ...(patch.antiIdle ?? {}) },
    reconnect: { ...base.reconnect, ...(patch.reconnect ?? {}) },
    timeouts: { ...base.timeouts, ...(patch.timeouts ?? {}) },
  };
  registerSecret(next.credentials.password);
  registerSecret(next.credentials.password2);
  registerSecret(next.accessToken);
  return next;
}

/** Fill a command template (`{password}`, `{password2}`, `{username}`). */
export function fillCommand(template: string, credentials: CredentialsConfig): string {
  return template
    .replace(/\{password2\}/g, credentials.password2 ?? credentials.password ?? "")
    .replace(/\{password\}/g, credentials.password ?? "")
    .replace(/\{username\}/g, credentials.username);
}

/** Validate config; returns human-readable problems (empty when valid). */
export function validateConfig(config: BotConfig): string[] {
  const problems: string[] = [];
  if (!config.host) problems.push("Server host is empty");
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    problems.push(`Invalid port ${config.port}`);
  }
  if (!config.credentials.username) problems.push("Username is empty");
  if (config.versionMode === "fixed" && config.protocolVersion <= 0) {
    problems.push("Fixed version mode requires a positive protocol number");
  }
  if (!RESOURCE_PACK_POLICIES.includes(config.resourcePack.policy)) {
    problems.push(`Unknown resource-pack policy "${config.resourcePack.policy}"`);
  }
  return problems;
}

/** Redacted view of the config for dashboards (no secrets, ever). */
export function describeConfig(config: BotConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    resolveSrv: config.resolveSrv,
    versionMode: config.versionMode,
    protocolVersion: config.protocolVersion,
    versionName: config.versionName,
    authMode: config.authMode,
    username: config.credentials.username,
    hasPassword: Boolean(config.credentials.password),
    hasAccessToken: Boolean(config.accessToken),
    loginCommand: config.credentials.loginCommand,
    resourcePackPolicy: config.resourcePack.policy,
    guiAuthEnabled: config.guiAuth.enabled,
    antiIdle: config.antiIdle.enabled,
    reconnect: config.reconnect.enabled,
  };
}
