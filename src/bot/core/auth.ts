/**
 * Authentication flow: chat prompts, titles/boss bars/action bars, sign
 * editors and inventory GUIs.
 *
 * The flow is a pure state machine driven by observed signals; the bot layer
 * turns the emitted actions into packets. Passwords are never included in
 * returned notes or log lines (the logger redacts them as well).
 */
import { registerSecret } from "./redact";
import type { BotLogger } from "./logger";
import { fillCommand, type CredentialsConfig, type GuiAuthConfig } from "./config";

export type AuthStatus =
  | "idle"
  | "prompted"
  | "submitting"
  | "submitted"
  | "succeeded"
  | "failed"
  | "timeout";

export type AuthSource =
  | "chat"
  | "title"
  | "subtitle"
  | "actionbar"
  | "bossbar"
  | "window"
  | "dialog"
  | "sign";

export interface AuthPrompt {
  source: AuthSource;
  text: string;
  /** "login" | "register" based on wording. */
  intent: "login" | "register";
  at: number;
}

export interface WindowSummary {
  windowId: number;
  stateId: number;
  title: string;
  /** slot -> display name (from item components). */
  items: Record<number, string>;
}

export type AuthAction =
  | { type: "command"; command: string; reason: string }
  | { type: "click"; windowId: number; stateId: number; slot: number; reason: string }
  | { type: "sign"; lines: string[]; reason: string }
  | { type: "note"; note: string };

export interface AuthState {
  status: AuthStatus;
  prompt: AuthPrompt | null;
  attempts: number;
  submittedAt: number | null;
  lastError: string | null;
  successText: string | null;
  /** Set when a login-style GUI window is currently open. */
  guiWindow: WindowSummary | null;
  history: Array<{ at: number; event: string; detail?: string }>;
}

export interface AuthFlowOptions {
  credentials: CredentialsConfig;
  gui: GuiAuthConfig;
  logger: Pick<BotLogger, "debug" | "info" | "warn" | "error">;
  now?: () => number;
}

const LOGIN_RE =
  /\b(log\s?in|sign\s?in|authenticate|authentication|enter\s+(?:your\s+)?password|password\s*required|session\s+(?:required|expired)|you\s+must\s+(?:log\s?in|login))\b/i;
const REGISTER_RE =
  /\b(register|create\s+(?:an?\s+)?account|choose\s+(?:a\s+)?password|set\s+(?:your\s+)?password)\b/i;
const SUCCESS_RE =
  /\b(successfully\s+logged\s?in|logged\s?in\s+successfully|welcome\s+back|authentication\s+(?:complete|successful|succeeded)|login\s+(?:successful|success)|now\s+logged\s?in)\b/i;
const FAILURE_RE =
  /\b(invalid|incorrect|wrong|bad)\s+(?:password|pass|credentials?)\b|\b(login|authentication)\s+failed\b|\bpasswords?\s+(?:do\s+not|doesn'?t)\s+match\b|\balready\s+registered\b|\btoo\s+many\s+(?:attempts|tries)\b/i;

const GUI_TITLE_RE =
  /\b(login|log\s?in|sign\s?in|register|authentication|auth|password|verify|session|wh)\b/i;
const GUI_ITEM_LOGIN_RE = /\b(log\s?in|sign\s?in|authenticate|enter|password|continue)\b/i;
const GUI_ITEM_REGISTER_RE = /\b(register|sign\s?up|create)\b/i;

export function detectIntent(text: string): "login" | "register" | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  if (SUCCESS_RE.test(cleaned) && !LOGIN_RE.test(cleaned)) return null;
  if (REGISTER_RE.test(cleaned)) return "register";
  if (LOGIN_RE.test(cleaned)) return "login";
  return null;
}

export function isSuccessText(text: string): boolean {
  return SUCCESS_RE.test(text);
}

export function isFailureText(text: string): boolean {
  return FAILURE_RE.test(text);
}

export class AuthFlow {
  private readonly options: AuthFlowOptions;
  private stateValue: AuthState;
  private lastSubmitAt = 0;

  constructor(options: AuthFlowOptions) {
    this.options = options;
    registerSecret(options.credentials.password);
    registerSecret(options.credentials.password2);
    this.stateValue = {
      status: "idle",
      prompt: null,
      attempts: 0,
      submittedAt: null,
      lastError: null,
      successText: null,
      guiWindow: null,
      history: [],
    };
  }

  get state(): AuthState {
    return this.stateValue;
  }

  reset(): void {
    this.stateValue = {
      status: "idle",
      prompt: null,
      attempts: 0,
      submittedAt: null,
      lastError: null,
      successText: null,
      guiWindow: null,
      history: [],
    };
    this.lastSubmitAt = 0;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private note(event: string, detail?: string): void {
    this.stateValue.history.push({ at: this.now(), event, detail });
    if (this.stateValue.history.length > 60) this.stateValue.history.shift();
  }

  private terminal(): boolean {
    return this.stateValue.status === "succeeded";
  }

  /**
   * Feed observed text (chat, title, subtitle, action bar, boss bar, dialog).
   * Returns the actions the bot should perform (possibly empty).
   */
  observeText(source: AuthSource, text: string): AuthAction[] {
    if (!text) return [];
    const now = this.now();

    if (isSuccessText(text)) {
      if (!this.terminal()) {
        this.options.logger.info("auth", `Authentication success signal via ${source}.`);
      }
      this.stateValue.status = "succeeded";
      this.stateValue.successText = text;
      this.note("succeeded", source);
      this.stateValue.guiWindow = null;
      return [];
    }
    if (isFailureText(text)) {
      this.stateValue.status = "failed";
      this.stateValue.lastError = text;
      this.note("failed", source);
      this.options.logger.warn("auth", `Authentication failure signal via ${source}: "${text}"`);
      // Retry once with the register command when it looks like a missing account.
      if (/already|not registered|no account|first/i.test(text)) {
        return this.buildCommand("register", "failure suggests no account exists");
      }
      return [];
    }

    const intent = detectIntent(text);
    if (!intent) return [];
    if (this.terminal()) return [];
    // Ignore repeated identical prompts while a submission is in flight.
    if (this.stateValue.status === "submitted" && now - (this.stateValue.submittedAt ?? 0) < 3000) {
      return [];
    }

    this.stateValue.status = "prompted";
    this.stateValue.prompt = { source, text, intent, at: now };
    this.note("prompted", `${source}: ${intent}`);
    this.options.logger.info(
      "auth",
      `Authentication prompt detected via ${source} (intent: ${intent}).`,
    );

    if (this.options.gui.enabled && this.stateValue.guiWindow && this.stateValue.guiWindow.title) {
      const click = this.guiClickAction(this.stateValue.guiWindow, intent);
      if (click) {
        this.stateValue.status = "submitting";
        this.stateValue.submittedAt = now;
        this.stateValue.attempts += 1;
        return [click];
      }
    }
    return this.buildCommand(intent, `prompt via ${source}`);
  }

  /** Observe an opened container window (possible login GUI). */
  observeWindow(window: WindowSummary): AuthAction[] {
    const now = this.now();
    if (this.terminal()) {
      this.stateValue.guiWindow = window;
      return [];
    }
    // Never fire a second submission while one is in flight.
    if (
      this.stateValue.status === "submitting" ||
      (this.stateValue.status === "submitted" && now - (this.stateValue.submittedAt ?? 0) < 4000)
    ) {
      this.stateValue.guiWindow = window;
      return [];
    }
    if (Object.keys(window.items).length === 0) {
      // Contents have not arrived yet; decide once slots are known.
      this.stateValue.guiWindow = window;
      this.note("window-open", `${window.title} (awaiting contents)`);
      return [];
    }
    const titleMatches = GUI_TITLE_RE.test(window.title);
    const itemEntries = Object.entries(window.items);
    const itemMatch = itemEntries.find(([, name]) =>
      /\b(login|log\s?in|sign\s?in|register|password|authenticate|auth|verify)\b/i.test(name ?? ""),
    );
    this.stateValue.guiWindow = window;

    if (!titleMatches && !itemMatch) {
      this.note("window-ignored", window.title);
      return [];
    }
    const intent: "login" | "register" = itemEntries.some(([, name]) =>
      GUI_ITEM_REGISTER_RE.test(name ?? ""),
    )
      ? itemMatch && GUI_ITEM_LOGIN_RE.test(itemMatch[1] ?? "")
        ? "login"
        : detectIntent(window.title) ?? "register"
      : detectIntent(window.title) ?? "login";

    this.stateValue.status = "prompted";
    this.stateValue.prompt = {
      source: "window",
      text: `GUI window "${window.title}" (window ${window.windowId})`,
      intent,
      at: this.now(),
    };
    this.note("gui-window", `${window.title} slots=${itemEntries.length}`);
    this.options.logger.info(
      "auth",
      `Login GUI detected: window ${window.windowId} titled "${window.title}" ` +
        `with ${itemEntries.length} filled slot(s); submitting through container interaction.`,
      { windowId: window.windowId, title: window.title },
    );

    if (!this.options.gui.enabled) {
      this.options.logger.warn("auth", "GUI auth is disabled in config; falling back to chat command.");
      return this.buildCommand(intent, "GUI detected but guiAuth.enabled=false");
    }
    const click = this.guiClickAction(window, intent);
    if (click) {
      this.stateValue.status = "submitting";
      this.stateValue.submittedAt = this.now();
      this.stateValue.attempts += 1;
      return [click];
    }
    this.options.logger.warn(
      "auth",
      "Login GUI detected but no actionable slot found; falling back to chat command.",
    );
    return this.buildCommand(intent, "GUI slot not found");
  }

  /** Called when a sign editor opens (password entry via sign). */
  observeSignEditor(): AuthAction[] {
    const password = this.options.credentials.password;
    if (!password) return [];
    this.note("sign-editor", "password will be typed into sign line 1");
    this.options.logger.info("auth", "Sign editor opened; submitting password as sign text.");
    this.stateValue.status = "submitted";
    this.stateValue.submittedAt = this.now();
    this.stateValue.attempts += 1;
    return [{ type: "sign", lines: [password, "", "", ""], reason: "sign editor authentication" }];
  }

  /** Called when the window closes (plugins close GUIs after a click). */
  observeWindowClosed(windowId: number): void {
    if (this.stateValue.guiWindow?.windowId === windowId) {
      this.stateValue.guiWindow = null;
      if (this.stateValue.status === "submitting") {
        this.stateValue.status = "submitted";
        this.note("gui-clicked", `window ${windowId} closed after click`);
      }
    }
  }

  private guiClickAction(window: WindowSummary, intent: "login" | "register"): AuthAction | null {
    const configured = this.options.gui.slots;
    if (configured.length > 0) {
      const slot = configured[0];
      return {
        type: "click",
        windowId: window.windowId,
        stateId: window.stateId,
        slot,
        reason: `configured GUI slot ${slot}`,
      };
    }
    const entries = Object.entries(window.items);
    const loginEntry = entries.find(([, name]) => GUI_ITEM_LOGIN_RE.test(name ?? ""));
    const registerEntry = entries.find(([, name]) => GUI_ITEM_REGISTER_RE.test(name ?? ""));
    const chosen =
      intent === "register" ? registerEntry ?? loginEntry : loginEntry ?? registerEntry;
    if (chosen) {
      return {
        type: "click",
        windowId: window.windowId,
        stateId: window.stateId,
        slot: Number(chosen[0]),
        reason: `item "${chosen[1]}" matched ${intent} intent`,
      };
    }
    if (entries.length === 1) {
      return {
        type: "click",
        windowId: window.windowId,
        stateId: window.stateId,
        slot: Number(entries[0][0]),
        reason: "only filled slot in login GUI",
      };
    }
    return null;
  }

  private buildCommand(intent: "login" | "register", reason: string): AuthAction[] {
    const { credentials } = this.options;
    if (!credentials.password) {
      this.options.logger.error(
        "auth",
        `Authentication required but no password configured (intent: ${intent}). ` +
          `Set MC_PASSWORD or use the dashboard Credentials panel.`,
      );
      this.note("missing-password", intent);
      return [];
    }
    const now = this.now();
    if (now - this.lastSubmitAt < 1500 && this.stateValue.attempts > 0) return [];
    this.lastSubmitAt = now;

    const template = intent === "register" ? credentials.registerCommand : credentials.loginCommand;
    const command = fillCommand(template, credentials);
    this.stateValue.status = "submitted";
    this.stateValue.submittedAt = now;
    this.stateValue.attempts += 1;
    this.note("submitted", `${intent} via chat (${reason})`);
    this.options.logger.info(
      "auth",
      `Submitting authentication via chat (attempt ${this.stateValue.attempts}, ${reason}); ` +
        `command template "${template}" (secret redacted).`,
    );
    return [{ type: "command", command, reason }];
  }

  /** Timeouts/retries. Call on a timer from the bot loop. */
  tick(): AuthAction[] {
    const now = this.now();
    const { status, submittedAt } = this.stateValue;
    const timeout = this.options.gui.timeoutMs;
    if ((status === "submitted" || status === "submitting") && submittedAt && now - submittedAt > timeout) {
      if (this.stateValue.attempts < 2 && this.options.credentials.password) {
        this.options.logger.warn(
          "auth",
          `No authentication result after ${Math.round(timeout / 1000)}s; retrying once.`,
        );
        this.stateValue.status = "prompted";
        this.stateValue.submittedAt = null;
        return this.buildCommand("login", "retry after timeout");
      }
      this.stateValue.status = "timeout";
      this.note("timeout", `${Math.round(timeout / 1000)}s`);
      this.options.logger.error(
        "auth",
        `Authentication timed out after ${this.stateValue.attempts} attempt(s). ` +
          `Check the server's expected command (loginCommand/registerCommand) and GUI behaviour.`,
      );
    }
    if (status === "prompted" && this.stateValue.prompt && now - this.stateValue.prompt.at > 5000) {
      // Prompt seen but nothing actionable happened (e.g. waiting for user input).
      return this.buildCommand(this.stateValue.prompt.intent, "pending prompt");
    }
    return [];
  }

  /** Compact snapshot for dashboards (never includes the password). */
  describe(): Record<string, unknown> {
    return {
      status: this.stateValue.status,
      attempts: this.stateValue.attempts,
      promptSource: this.stateValue.prompt?.source ?? null,
      promptIntent: this.stateValue.prompt?.intent ?? null,
      hasPassword: Boolean(this.options.credentials.password),
      guiOpen: Boolean(this.stateValue.guiWindow),
      guiTitle: this.stateValue.guiWindow?.title ?? null,
      lastError: this.stateValue.lastError,
      history: this.stateValue.history.slice(-8),
    };
  }
}
