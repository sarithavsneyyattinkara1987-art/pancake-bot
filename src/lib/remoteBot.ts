/**
 * Browser side of the bot bridge.
 *
 * The dashboard is a *remote control*: it holds no Minecraft connection, no
 * protocol engine and no password. It:
 *
 *   1. opens one authenticated WebSocket to the backend (auto-reconnecting),
 *   2. streams snapshots + logs from it into the existing dashboard panels,
 *   3. forwards validated commands and settings to it.
 *
 * Because the backend owns the single bot instance, closing the phone, closing
 * every tab or refreshing has no effect on the running Minecraft connection.
 */
import type {
  BackendSettings,
  BotSnapshot,
  BridgeMessage,
  BridgeRequest,
  BridgeStatus,
  CommandOutcome,
  LogEntry,
  SettingsPush,
} from "./bridgeProtocol";

const URL_KEY = "pancakebot.bridge.url";
const TOKEN_KEY = "pancakebot.bridge.token";
const COMMAND_TIMEOUT_MS = 15000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/** Vite bakes these in at build time; the dashboard can also override them. */
function envDefaults(): { url: string | null; token: string | null } {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  const url = env?.VITE_BOT_BACKEND_URL?.trim() || null;
  const token = env?.VITE_BOT_BACKEND_TOKEN?.trim() || null;
  return { url, token };
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private modes; the session still works.
  }
}

export interface NormalizedEndpoint {
  ws: string;
  http: string;
}

/**
 * Accepts `host:port`, `http(s)://host`, `ws(s)://host` and normalises to a
 * WebSocket + HTTP pair, so the phone can be configured with whichever URL the
 * backend printed.
 */
export function normalizeEndpoint(input: string): NormalizedEndpoint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^[a-z]+:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  try {
    const url = new URL(candidate);
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const wsProtocol = secure ? "wss:" : "ws:";
    const httpProtocol = secure ? "https:" : "http:";
    const authority = url.host;
    if (!authority) return null;
    return { ws: `${wsProtocol}//${authority}`, http: `${httpProtocol}//${authority}` };
  } catch {
    return null;
  }
}

export interface BridgeState {
  status: BridgeStatus;
  settings: BackendSettings | null;
  snapshot: BotSnapshot | null;
  target: string | null;
  lastError: string | null;
}

type Listener<T> = (value: T) => void;

class BotBridge {
  private socket: WebSocket | null = null;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private pending = new Map<string, { resolve: (outcome: CommandOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

  private state: BridgeState = {
    status: "disabled",
    settings: null,
    snapshot: null,
    target: null,
    lastError: null,
  };

  private readonly snapshotListeners = new Set<Listener<BotSnapshot>>();
  private readonly logListeners = new Set<Listener<LogEntry>>();
  private readonly statusListeners = new Set<Listener<BridgeStatus>>();
  private readonly settingsListeners = new Set<Listener<BackendSettings>>();

  /* ----------------------------------------------------------- configuration */

  getUrl(): string | null {
    return readStorage(URL_KEY) ?? envDefaults().url;
  }

  getToken(): string | null {
    return readStorage(TOKEN_KEY) ?? envDefaults().token;
  }

  isConfigured(): boolean {
    return this.getUrl() !== null && this.getToken() !== null;
  }

  configure(url: string | null, token: string | null): void {
    writeStorage(URL_KEY, url && url.trim() ? url.trim() : null);
    writeStorage(TOKEN_KEY, token && token.trim() ? token.trim() : null);
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.stop();
    if (this.isConfigured()) this.start();
    else this.setStatus("disabled", null);
  }

  getState(): BridgeState {
    return this.state;
  }

  /* ------------------------------------------------------------- subscriptions */

  onSnapshot(listener: Listener<BotSnapshot>): () => void {
    this.snapshotListeners.add(listener);
    if (this.state.snapshot) listener(this.state.snapshot);
    return () => this.snapshotListeners.delete(listener);
  }

  onLog(listener: Listener<LogEntry>): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStatus(listener: Listener<BridgeStatus>): () => void {
    this.statusListeners.add(listener);
    listener(this.state.status);
    return () => this.statusListeners.delete(listener);
  }

  onSettings(listener: Listener<BackendSettings>): () => void {
    this.settingsListeners.add(listener);
    if (this.state.settings) listener(this.state.settings);
    return () => this.settingsListeners.delete(listener);
  }

  private setStatus(status: BridgeStatus, error: string | null): void {
    if (this.state.status === status && this.state.lastError === error) return;
    this.state = { ...this.state, status, lastError: error };
    for (const listener of this.statusListeners) listener(status);
  }

  /* ------------------------------------------------------------------ connect */

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.isConfigured()) {
      this.setStatus("disabled", null);
      return;
    }
    this.open();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending("Bridge disconnected.");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  private open(): void {
    const rawUrl = this.getUrl();
    const token = this.getToken();
    const endpoint = rawUrl ? normalizeEndpoint(rawUrl) : null;
    if (!endpoint || !token) {
      this.setStatus("disabled", null);
      return;
    }

    if (typeof WebSocket === "undefined") {
      this.setStatus("offline", "WebSocket is unavailable in this environment.");
      return;
    }

    this.setStatus("connecting", null);
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${endpoint.ws}/ws?token=${encodeURIComponent(token)}`);
    } catch (err) {
      this.setStatus("offline", err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.setStatus("online", null);
    };

    socket.onmessage = (event) => {
      let message: BridgeMessage;
      try {
        message = JSON.parse(String(event.data)) as BridgeMessage;
      } catch {
        return;
      }
      this.handle(message);
    };

    socket.onerror = () => {
      // The close handler reports the state; keep the message concrete.
      this.setStatus("offline", `Cannot reach ${endpoint.ws}`);
    };

    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.failPending("Bridge connection closed.");
      if (event.code === 4401 || event.code === 401) {
        this.setStatus("unauthorized", "Bridge rejected the token.");
        this.started = false;
        return;
      }
      this.setStatus("offline", this.state.lastError ?? "Bridge disconnected.");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 1.7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) this.open();
    }, delay);
  }

  private handle(message: BridgeMessage): void {
    switch (message.type) {
      case "hello": {
        this.state = {
          ...this.state,
          status: "online",
          settings: message.settings,
          snapshot: message.snapshot,
          target: message.target,
          lastError: null,
        };
        for (const listener of this.settingsListeners) listener(message.settings);
        for (const listener of this.snapshotListeners) listener(message.snapshot);
        for (const entry of message.logs) for (const listener of this.logListeners) listener(entry);
        break;
      }
      case "snapshot": {
        this.state = { ...this.state, snapshot: message.snapshot };
        for (const listener of this.snapshotListeners) listener(message.snapshot);
        break;
      }
      case "log": {
        for (const entry of message.entries) for (const listener of this.logListeners) listener(entry);
        break;
      }
      case "settings": {
        this.state = { ...this.state, settings: message.settings };
        for (const listener of this.settingsListeners) listener(message.settings);
        break;
      }
      case "commandResult": {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        entry.resolve({ ok: message.ok, lines: message.lines });
        break;
      }
      case "error": {
        this.state = { ...this.state, lastError: message.message };
        break;
      }
      case "pong":
        break;
    }
  }

  private failPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ ok: false, lines: [reason] });
    }
  }

  /* ------------------------------------------------------------------ commands */

  /** Send a console command to the backend. Never throws for bot-side errors. */
  async command(input: string): Promise<CommandOutcome> {
    const socket = this.socket;
    const endpoint = this.getUrl() ? normalizeEndpoint(this.getUrl() as string) : null;
    const token = this.getToken();

    if (socket && socket.readyState === WebSocket.OPEN && endpoint && token) {
      const id = crypto.randomUUID();
      return new Promise<CommandOutcome>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ ok: false, lines: ["Timed out waiting for the backend."] });
        }, COMMAND_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
        const request: BridgeRequest = { type: "command", id, input };
        try {
          socket.send(JSON.stringify(request));
        } catch (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve({ ok: false, lines: [err instanceof Error ? err.message : String(err)] });
        }
      });
    }

    if (endpoint && token) {
      return this.httpCommand(endpoint.http, token, input);
    }
    return { ok: false, lines: ["No bot backend configured. Open Settings and add the backend URL + token."] };
  }

  private async httpCommand(httpBase: string, token: string, input: string): Promise<CommandOutcome> {
    try {
      const response = await fetch(`${httpBase}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ input }),
      });
      if (response.status === 401) {
        this.setStatus("unauthorized", "Bridge rejected the token.");
        return { ok: false, lines: ["Backend rejected the token."] };
      }
      const body = (await response.json()) as { ok?: boolean; lines?: string[]; error?: string };
      return { ok: Boolean(body.ok), lines: body.lines ?? (body.error ? [body.error] : []) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("offline", message);
      return { ok: false, lines: [`Cannot reach the backend: ${message}`] };
    }
  }

  /* ------------------------------------------------------------------ settings */

  /**
   * Push dashboard settings to the backend. The password travels here exactly
   * once and is never returned; the backend replies with a `hasPassword` flag.
   */
  async pushSettings(
    settings: SettingsPush,
    password?: string,
  ): Promise<{ ok: boolean; problems: string[]; settings: BackendSettings | null }> {
    const rawUrl = this.getUrl();
    const endpoint = rawUrl ? normalizeEndpoint(rawUrl) : null;
    const token = this.getToken();
    if (!endpoint || !token) {
      return { ok: false, problems: ["No bot backend configured."], settings: null };
    }
    try {
      const response = await fetch(`${endpoint.http}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings, ...(password ? { password } : {}) }),
      });
      if (response.status === 401) {
        this.setStatus("unauthorized", "Bridge rejected the token.");
        return { ok: false, problems: ["Backend rejected the token."], settings: null };
      }
      const body = (await response.json()) as {
        ok?: boolean;
        problems?: string[];
        settings?: BackendSettings;
        error?: string;
      };
      if (body.settings) {
        this.state = { ...this.state, settings: body.settings };
        for (const listener of this.settingsListeners) listener(body.settings);
      }
      return {
        ok: Boolean(body.ok),
        problems: body.problems ?? (body.error ? [body.error] : []),
        settings: body.settings ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("offline", message);
      return { ok: false, problems: [`Cannot reach the backend: ${message}`], settings: null };
    }
  }

  /** One-shot REST read used to fill the dashboard before the socket is up. */
  async fetchState(): Promise<{
    settings: BackendSettings;
    snapshot: BotSnapshot;
    logs: LogEntry[];
    target: string;
  } | null> {
    const rawUrl = this.getUrl();
    const endpoint = rawUrl ? normalizeEndpoint(rawUrl) : null;
    const token = this.getToken();
    if (!endpoint || !token) return null;
    try {
      const response = await fetch(`${endpoint.http}/api/state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        settings: BackendSettings;
        snapshot: BotSnapshot;
        logs: LogEntry[];
        target: string;
      };
      this.state = { ...this.state, settings: body.settings, snapshot: body.snapshot, target: body.target };
      return body;
    } catch {
      return null;
    }
  }
}

export const bridge = new BotBridge();
