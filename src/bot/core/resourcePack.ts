/**
 * Resource-pack prompt handling.
 *
 * Detects Resource Pack Push packets (configuration + play phases), records
 * URL/hash/required/prompt, applies the configured policy, optionally
 * downloads the pack with hash verification (never executing it), and maps the
 * outcome onto the protocol's Resource Pack Response statuses.
 *
 * Policies:
 *   accept              – accept and confirm loaded (pack bytes are irrelevant
 *                         to a headless client, which is logged explicitly)
 *   decline             – decline, even if the server marks it required
 *   required-only       – accept only when the server requires it
 *   download-and-accept – download, verify the hash, cache, then confirm
 *
 * Every path is logged; a required pack that cannot be satisfied ends in a
 * clear, actionable diagnostic instead of a silent hang.
 */
import { sha1, sha256, toHex } from "../protocol/crypto";
import type { BotLogger } from "./logger";

export type ResourcePackPolicy =
  | "accept"
  | "decline"
  | "required-only"
  | "download-and-accept";

/** Wire values (MCProtocolLib 1.21 ordinal order). */
export const ResourcePackStatus = {
  SUCCESSFULLY_LOADED: 0,
  DECLINED: 1,
  FAILED_DOWNLOAD: 2,
  ACCEPTED: 3,
  DOWNLOADED: 4,
  INVALID_URL: 5,
  FAILED_RELOAD: 6,
  DISCARDED: 7,
} as const;

export type ResourcePackStatusValue = (typeof ResourcePackStatus)[keyof typeof ResourcePackStatus];

export type ResourcePackPhase =
  | "idle"
  | "requested"
  | "downloading"
  | "accepted"
  | "loaded"
  | "declined"
  | "failed"
  | "timeout";

export interface ResourcePackRequest {
  /** Pack UUID assigned by the server. */
  id: string;
  url: string;
  /** Hex SHA-1 (40) or SHA-256 (64) hash; may be empty. */
  hash: string;
  required: boolean;
  prompt?: string;
  source: "configuration" | "play";
  receivedAt: number;
}

export interface ResourcePackResponse {
  id: string;
  status: ResourcePackStatusValue;
  note: string;
}

export interface PackHistoryEvent {
  at: number;
  event: string;
  detail?: string;
}

export interface ResourcePackState {
  phase: ResourcePackPhase;
  request: ResourcePackRequest | null;
  /** Statuses queued/sent for the current request. */
  responses: ResourcePackResponse[];
  downloadedBytes: number;
  verified: boolean;
  cached: boolean;
  lastError?: string;
  history: PackHistoryEvent[];
}

export interface ResourcePackConfigLike {
  policy: ResourcePackPolicy;
  timeoutMs: number;
  maxBytes: number;
  cache: boolean;
}

export interface ResourcePackOutcome {
  ok: boolean;
  /** Whether the bot must disconnect (required pack that could not be applied). */
  fatal: boolean;
  responses: ResourcePackResponse[];
  diagnostic?: string;
}

export interface ResourcePackRuntime {
  logger: Pick<BotLogger, "debug" | "info" | "warn" | "error">;
  fetchImpl?: typeof fetch;
  /** Shared session cache keyed by hash/url. */
  cache?: Map<string, Uint8Array>;
  now?: () => number;
}

function defaultNow(): number {
  return Date.now();
}

export class ResourcePackHandler {
  private readonly config: ResourcePackConfigLike;
  private readonly runtime: ResourcePackRuntime;
  private readonly cache: Map<string, Uint8Array>;
  private stateValue: ResourcePackState;

  constructor(config: ResourcePackConfigLike, runtime: ResourcePackRuntime) {
    this.config = config;
    this.runtime = runtime;
    this.cache = runtime.cache ?? new Map<string, Uint8Array>();
    this.stateValue = {
      phase: "idle",
      request: null,
      responses: [],
      downloadedBytes: 0,
      verified: false,
      cached: false,
      history: [],
    };
  }

  get state(): ResourcePackState {
    return this.stateValue;
  }

  reset(): void {
    this.stateValue = {
      phase: "idle",
      request: null,
      responses: [],
      downloadedBytes: 0,
      verified: false,
      cached: false,
      history: [],
    };
  }

  private now(): number {
    return (this.runtime.now ?? defaultNow)();
  }

  private note(event: string, detail?: string): void {
    this.stateValue.history.push({ at: this.now(), event, detail });
    if (this.stateValue.history.length > 50) this.stateValue.history.shift();
  }

  /**
   * Handle a Resource Pack Push. Returns the ordered responses the client must
   * send (possibly after a download), plus a diagnostic when a required pack
   * could not be satisfied.
   */
  async handle(request: ResourcePackRequest): Promise<ResourcePackOutcome> {
    const log = this.runtime.logger;
    const policy = this.config.policy;
    this.stateValue = {
      ...this.stateValue,
      phase: "requested",
      request,
      responses: [],
      downloadedBytes: 0,
      verified: false,
      cached: false,
      lastError: undefined,
    };
    this.note("requested", `${request.required ? "required" : "optional"} pack ${request.url}`);

    log.info(
      "resourcepack",
      `Resource pack requested (${request.source} phase, ${request.required ? "REQUIRED" : "optional"}): ${request.url}` +
        (request.hash ? ` hash=${request.hash}` : " hash=<none>") +
        (request.prompt ? ` prompt="${request.prompt}"` : ""),
      { id: request.id, required: request.required, policy },
    );

    const willDecline =
      policy === "decline" || (policy === "required-only" && !request.required);

    if (willDecline) {
      if (request.required && policy === "decline") {
        log.warn(
          "resourcepack",
          "Policy is \"decline\" but the server REQUIRES the pack — expect a kick; " +
            "switch RESOURCE_PACK_POLICY to \"accept\" or \"download-and-accept\" if you want to join.",
        );
      }
      this.stateValue.phase = "declined";
      const responses = [this.respond(request.id, ResourcePackStatus.DECLINED, "declined by policy")];
      this.stateValue.responses = responses;
      this.note("declined", `policy=${policy}`);
      return {
        ok: !request.required,
        fatal: request.required,
        responses,
        diagnostic: request.required
          ? `Server requires resource pack ${request.url} but policy "${policy}" declines it.`
          : undefined,
      };
    }

    if (policy === "accept") {
      // Headless client: nothing renders the pack, but the server must see a
      // successful load to continue. Documented, not silent.
      log.info(
        "resourcepack",
        "Policy \"accept\": confirming load without downloading pack bytes " +
          "(a headless client never renders the pack).",
      );
      const responses = [
        this.respond(request.id, ResourcePackStatus.ACCEPTED, "accepted by policy"),
        this.respond(request.id, ResourcePackStatus.SUCCESSFULLY_LOADED, "confirmed loaded"),
      ];
      this.stateValue.phase = "loaded";
      this.stateValue.responses = responses;
      this.note("loaded", "policy=accept (no download)");
      return { ok: true, fatal: false, responses };
    }

    if (policy === "required-only") {
      // required && policy required-only => accept
      const responses = [
        this.respond(request.id, ResourcePackStatus.ACCEPTED, "required pack accepted"),
        this.respond(request.id, ResourcePackStatus.SUCCESSFULLY_LOADED, "required pack confirmed"),
      ];
      this.stateValue.phase = "loaded";
      this.stateValue.responses = responses;
      this.note("loaded", "policy=required-only");
      return { ok: true, fatal: false, responses };
    }

    // policy === "download-and-accept"
    const responses: ResourcePackResponse[] = [
      this.respond(request.id, ResourcePackStatus.ACCEPTED, "accepted, starting download"),
    ];
    const download = await this.download(request);
    if (!download.ok) {
      const failed: ResourcePackResponse = this.respond(
        request.id,
        download.invalidUrl ? ResourcePackStatus.INVALID_URL : ResourcePackStatus.FAILED_DOWNLOAD,
        download.error ?? "download failed",
      );
      responses.push(failed);
      this.stateValue.phase = "failed";
      this.stateValue.lastError = download.error;
      this.stateValue.responses = responses;
      this.note("failed", download.error);
      log.error(
        "resourcepack",
        `Resource pack download failed: ${download.error}` +
          (request.required ? " — server marked it REQUIRED, disconnecting." : ""),
      );
      return {
        ok: !request.required,
        fatal: request.required,
        responses,
        diagnostic: request.required
          ? `Required resource pack failed to download (${download.error}) from ${request.url}`
          : undefined,
      };
    }

    const packBytes = download.bytes ?? new Uint8Array(0);
    this.stateValue.downloadedBytes = packBytes.byteLength;
    this.stateValue.verified = download.verified;
    this.stateValue.cached = download.cached;
    responses.push(this.respond(request.id, ResourcePackStatus.DOWNLOADED, "download verified"));
    responses.push(
      this.respond(request.id, ResourcePackStatus.SUCCESSFULLY_LOADED, "pack loaded into cache"),
    );
    this.stateValue.phase = "loaded";
    this.stateValue.responses = responses;
    this.note("loaded", `${packBytes.byteLength} bytes`);
    return { ok: true, fatal: false, responses };
  }

  private respond(
    id: string,
    status: ResourcePackStatusValue,
    note: string,
  ): ResourcePackResponse {
    this.runtime.logger.debug("resourcepack", `Response ${statusName(status)} for pack ${id}: ${note}`);
    return { id, status, note };
  }

  private async download(
    request: ResourcePackRequest,
  ): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string; verified: boolean; cached: boolean; invalidUrl?: boolean }> {
    const url = request.url.trim();
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: `Unsupported resource pack URL scheme: ${url.slice(0, 32)}`, verified: false, cached: false, invalidUrl: true };
    }
    const cacheKey = request.hash || url;
    if (this.config.cache && this.cache.has(cacheKey)) {
      this.runtime.logger.info("resourcepack", "Resource pack served from session cache (no re-download).");
      return { ok: true, bytes: this.cache.get(cacheKey)!, verified: true, cached: true };
    }

    this.stateValue.phase = "downloading";
    const log = this.runtime.logger;
    log.info("resourcepack", `Downloading resource pack (${this.config.timeoutMs}ms timeout, max ${this.config.maxBytes} bytes)...`);

    const fetchImpl = this.runtime.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) return { ok: false, error: "No fetch implementation available", verified: false, cached: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status} ${response.statusText}`, verified: false, cached: false };
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > this.config.maxBytes) {
        return { ok: false, error: `Pack is ${declared} bytes, above limit ${this.config.maxBytes}`, verified: false, cached: false };
      }

      let bytes: Uint8Array;
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > this.config.maxBytes) {
            await reader.cancel();
            return { ok: false, error: `Pack exceeded ${this.config.maxBytes} byte limit during download`, verified: false, cached: false };
          }
          chunks.push(value);
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > this.config.maxBytes) {
          return { ok: false, error: `Pack is ${buffer.byteLength} bytes, above limit ${this.config.maxBytes}`, verified: false, cached: false };
        }
        bytes = new Uint8Array(buffer);
      }

      let verified = false;
      const hash = request.hash.trim().toLowerCase();
      if (hash) {
        const digest =
          hash.length === 40 ? toHex(await sha1(bytes)) : hash.length === 64 ? toHex(await sha256(bytes)) : null;
        if (digest === null) {
          return { ok: false, error: `Server sent an unusable hash "${request.hash}"`, verified: false, cached: false };
        }
        if (digest !== hash) {
          return {
            ok: false,
            error: `Hash mismatch: expected ${hash} got ${digest}`,
            verified: false,
            cached: false,
          };
        }
        verified = true;
      } else {
        log.warn("resourcepack", "Server sent no pack hash; integrity cannot be verified.");
      }

      if (this.config.cache) this.cache.set(cacheKey, bytes);
      const ms = Date.now() - started;
      log.info(
        "resourcepack",
        `Resource pack downloaded: ${bytes.byteLength} bytes in ${ms}ms${verified ? " (hash verified)" : ""}.`,
      );
      return { ok: true, bytes, verified, cached: false };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Download timed out after ${this.config.timeoutMs}ms`
            : err.message
          : String(err);
      return { ok: false, error: message, verified: false, cached: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function statusName(status: number): string {
  const entry = Object.entries(ResourcePackStatus).find(([, v]) => v === status);
  return entry ? entry[0] : `UNKNOWN(${status})`;
}

/** Compact snapshot for dashboards. */
export function describeResourcePackState(state: ResourcePackState): Record<string, unknown> {
  return {
    phase: state.phase,
    url: state.request?.url ?? null,
    required: state.request?.required ?? null,
    hash: state.request?.hash || null,
    source: state.request?.source ?? null,
    downloadedBytes: state.downloadedBytes,
    verified: state.verified,
    cached: state.cached,
    lastError: state.lastError ?? null,
    history: state.history.slice(-8),
  };
}
