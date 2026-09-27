/**
 * MinecraftClient: the transport-agnostic protocol state machine.
 *
 * Owns framing, compression, optional encryption, phase transitions
 * (status -> login -> configuration -> play), keep-alive watchdogs and packet
 * dispatch. It never blocks: every inbound packet is handled synchronously on
 * the event loop, and long operations (resource-pack downloads, Mojang join
 * calls) are awaited by short async helpers that cannot stall packet reading.
 *
 * Protocol/version handling follows the project rules:
 *   - version is auto-detected from the server's status response when
 *     `versionMode === "auto"`
 *   - if detection fails the configured fixed version is used, reported
 *     loudly, never silently guessed
 *   - the configured server address is exactly `pancakesmp.kinetic.host:25565`
 */
import { PacketError, MCReader, MCWriter, buildPacket } from "../protocol/primitives";
import {
  REGISTRY_774,
  requirePacketId,
  type ConnectionPhase,
  type ProtocolRegistry,
} from "../protocol/registry";
import { PacketFramer, decodeFrame, encodeFrame, type FrameCodec } from "../protocol/framing";
import { browserZlib, type ZlibCodec } from "../protocol/compression";
import { readComponent, readNbt, stripFormatting, nbtToText, type NbtValue } from "../protocol/nbt";
import { AesCfb8, randomBytes, rsaPkcs1v15Encrypt, computeServerHash } from "../protocol/crypto";
import { parseChunkPacket } from "../protocol/chunk";
import { readSlotList } from "../protocol/slots";
import * as P from "../protocol/packets";
import { createPlayHandlers } from "./playHandlers";
import type { BotConfig } from "./config";
import type { Transport } from "../transport/transport";
import type { BotLogger } from "./logger";
import { WorldState, type Vec3, type WindowState, type ChatLine } from "./world";
import {
  ResourcePackHandler,
  type ResourcePackRequest,
  type ResourcePackOutcome,
} from "./resourcePack";
import { offlineUuid } from "../protocol/uuid";

export type Phase = "idle" | "status" | "login" | "configuration" | "play";

export interface ServerStatus {
  host: string;
  port: number;
  latencyMs: number;
  versionName: string | null;
  protocol: number | null;
  playersOnline: number | null;
  playersMax: number | null;
  description: string;
  hasIcon: boolean | null;
  enforcesSecureChat: boolean | null;
  detectedAt: number;
  raw: unknown;
}

export interface ClientEventMap {
  phase: (phase: Phase) => void;
  status: (status: ServerStatus) => void;
  loginSuccess: (info: { uuid: string; username: string }) => void;
  playStart: (info: { entityId: number }) => void;
  disconnect: (info: { reason: string; byServer: boolean }) => void;
  error: (info: { context: string; message: string }) => void;
  chat: (info: { source: ChatLine["source"]; text: string }) => void;
  health: (info: { health: number; food: number; saturation: number }) => void;
  death: () => void;
  respawn: () => void;
  teleport: (info: { id: number; x: number; y: number; z: number; yaw: number; pitch: number }) => void;
  windowOpen: (info: { windowId: number; type: number; title: string }) => void;
  windowUpdate: (info: { windowId: number; stateId: number; count: number }) => void;
  windowClose: (info: { windowId: number }) => void;
  signEditor: (info: Vec3) => void;
  resourcePack: (info: {
    request: ResourcePackRequest;
    outcome: ResourcePackOutcome;
  }) => void;
  chunk: (info: { cx: number; cz: number }) => void;
  blockUpdate: (info: { x: number; y: number; z: number; state: number }) => void;
  players: () => void;
  entities: () => void;
  gameMode: (mode: number) => void;
  keepAlive: (rttMs: number) => void;
  packet: (info: { phase: ConnectionPhase; direction: "in" | "out"; name: string; bytes: number }) => void;
}

type Listener<K extends keyof ClientEventMap> = ClientEventMap[K];

export interface MinecraftClientOptions {
  config: BotConfig;
  transport: Transport;
  logger: BotLogger;
  registry?: ProtocolRegistry;
  zlib?: ZlibCodec;
  resourcePack: ResourcePackHandler;
  now?: () => number;
  /** Skip the status handshake (already detected). */
  knownStatus?: ServerStatus | null;
}

export class MinecraftClient {
  readonly config: BotConfig;
  readonly world = new WorldState();
  readonly registry: ProtocolRegistry;
  readonly resourcePack: ResourcePackHandler;
  readonly logger: BotLogger;
  /** Entity type id for "player" (null until the entity registry loads). */
  entityTypeId: number | null = null;

  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly framer = new PacketFramer();
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  private codec: FrameCodec;
  private zlibPromise: Promise<ZlibCodec> | null = null;

  private phaseValue: Phase = "idle";
  private cipherIn: AesCfb8 | null = null;
  private cipherOut: AesCfb8 | null = null;
  private rxChain: Promise<void> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private keepAliveSentAt: number | null = null;
  private keepAliveTimeoutMs: number;

  private status: ServerStatus | null;
  private statusSettled = false;
  /** Set while a status ping owns the transport; its close is intentional. */
  private benignClose = false;
  private connectSettled = false;
  private finishConfigurationReceived = false;
  private packBarrierActive = false;
  private sequence = 1;
  private closing = false;
  private closedReason: string | null = null;

  /** dimension type registry entries from configuration (min_y/height). */
  readonly dimensionTypes = new Map<string, { minY: number; height: number }>();

  constructor(options: MinecraftClientOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.logger = options.logger;
    this.registry = options.registry ?? REGISTRY_774;
    this.resourcePack = options.resourcePack;
    this.now = options.now ?? Date.now;
    this.status = options.knownStatus ?? null;
    this.keepAliveTimeoutMs = options.config.timeouts.keepAliveMs;
    this.codec = { threshold: -1, zlib: browserZlib };
    if (options.zlib) this.codec = { threshold: -1, zlib: options.zlib };
    this.transport.onData((bytes) => this.onData(bytes));
    this.transport.onClose((info) => this.onTransportClose(info));
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  get serverStatus(): ServerStatus | null {
    return this.status;
  }

  on<K extends keyof ClientEventMap>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: never[]) => void);
    return () => {
      set?.delete(listener as (...args: never[]) => void);
    };
  }

  emit<K extends keyof ClientEventMap>(event: K, ...args: Parameters<ClientEventMap[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this.logger.error("client", `Listener for "${event}" threw: ${errText(err)}`);
      }
    }
  }

  private setPhase(phase: Phase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    this.logger.debug("protocol", `Phase -> ${phase}`);
    this.emit("phase", phase);
  }

  // ------------------------------------------------------------ outbound

  /** Encode + frame + (optionally) encrypt + send a packet. */
  send(phase: ConnectionPhase, direction: "toServer" | "toClient", name: string, build: P.BuildFn): void {
    if (this.phaseValue === "idle") return;
    let id: number;
    try {
      id = requirePacketId(this.registry, phase, direction, name);
    } catch (err) {
      this.logger.error("protocol", errText(err));
      this.emit("error", { context: "send", message: errText(err) });
      return;
    }
    const payload = buildPacket(id, build);
    void this.sendPayload(phase, name, payload);
  }

  sendStatus(name: string, build: P.BuildFn): void {
    this.send("status", "toServer", name, build);
  }

  sendLogin(name: string, build: P.BuildFn): void {
    this.send("login", "toServer", name, build);
  }

  sendConfiguration(name: string, build: P.BuildFn): void {
    this.send("configuration", "toServer", name, build);
  }

  sendPlay(name: string, build: P.BuildFn): void {
    this.send("play", "toServer", name, build);
  }

  private async sendPayload(phase: ConnectionPhase, name: string, payload: Uint8Array): Promise<void> {
    try {
      const framed = await encodeFrame(payload, this.codec);
      const bytes = this.cipherOut ? this.cipherOut.process(framed) : framed;
      this.transport.send(bytes);
      this.emit("packet", { phase, direction: "out", name, bytes: bytes.byteLength });
    } catch (err) {
      this.logger.error("protocol", `Failed to send ${name}: ${errText(err)}`);
      this.emit("error", { context: `send:${name}`, message: errText(err) });
    }
  }

  // ------------------------------------------------------------ inbound

  private onData(raw: Uint8Array): void {
    this.lastInboundAt = this.now();
    const bytes = this.cipherIn ? this.cipherIn.process(raw) : raw;
    let frames: Uint8Array[];
    try {
      frames = this.framer.push(bytes);
    } catch (err) {
      this.logger.error("protocol", `Framing error: ${errText(err)}`);
      this.emit("error", { context: "framing", message: errText(err) });
      this.destroy("malformed frame from server");
      return;
    }
    for (const frame of frames) {
      this.rxChain = this.rxChain.then(() => this.processFrame(frame)).catch((err) => {
        this.logger.error("protocol", `Packet processing error: ${errText(err)}`);
        this.emit("error", { context: "packet", message: errText(err) });
        this.destroy(`packet processing error: ${errText(err)}`);
      });
    }
  }

  private async processFrame(frame: Uint8Array): Promise<void> {
    let payload: Uint8Array;
    try {
      payload = await decodeFrame(frame, this.codec);
    } catch (err) {
      this.logger.error("protocol", `Frame decode failed: ${errText(err)}`);
      this.emit("error", { context: "decode", message: errText(err) });
      this.destroy("failed to decode packet (compression mismatch?)");
      return;
    }
    const r = new MCReader(payload);
    let id: number;
    try {
      id = r.varint();
    } catch {
      this.logger.error("protocol", "Packet with unreadable id");
      return;
    }
    const phase = this.phaseValue === "idle" ? "status" : (this.phaseValue as ConnectionPhase);
    const name = this.registry.nameFor(phase, "toClient", id);
    this.emit("packet", { phase, direction: "in", name: name ?? `0x${id.toString(16)}`, bytes: payload.byteLength });

    try {
      const handler = this.resolveHandler(phase, name ?? "", id);
      if (handler) {
        await handler(r, name ?? `0x${id}`);
      } else {
        this.logger.debug(
          "protocol",
          `Unhandled ${phase}.toClient packet ${name ?? `0x${id.toString(16)}`} (${r.remaining} bytes left)`,
        );
      }
    } catch (err) {
      if (err instanceof PacketError && /end of packet/i.test(err.message)) {
        this.logger.warn(
          "protocol",
          `Truncated ${phase} packet "${name ?? id}" — server/client version mismatch? (${err.message})`,
        );
      } else {
        this.logger.error(
          "protocol",
          `Error handling ${phase} packet "${name ?? id}": ${errText(err)}`,
          { packet: name ?? `0x${id}` },
        );
      }
      this.emit("error", { context: `handle:${name ?? id}`, message: errText(err) });
    }
  }

  private resolveHandler(
    phase: ConnectionPhase,
    name: string,
    id: number,
  ): ((r: MCReader, name: string) => void | Promise<void>) | undefined {
    switch (phase) {
      case "status":
        return this.statusHandlers[name];
      case "login":
        return this.loginHandlers[name];
      case "configuration":
        return this.configurationHandlers[name];
      case "play":
        return this.playHandlers[name];
      default:
        void id;
        return undefined;
    }
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Detect the server version with a real status handshake (intent 1).
   * Returns null when detection fails; callers must then use the configured
   * fixed version (never a guess).
   */
  async detectStatus(): Promise<ServerStatus | null> {
    if (this.config.versionMode === "fixed") {
      this.logger.info(
        "version",
        `Version detection skipped (versionMode=fixed): using configured protocol ` +
          `${this.config.protocolVersion} (${this.config.versionName}).`,
      );
      return null;
    }
    return this.runStatusPing();
  }

  private async runStatusPing(): Promise<ServerStatus | null> {
    this.setPhase("status");
    this.statusSettled = false;
    // Every close until this ping settles (including a server that drops us)
    // is part of the status exchange: it must not surface as a disconnect or
    // leak closedReason into the login phase that follows.
    this.benignClose = true;
    const started = this.now();
    try {
      await this.transport.connect();
    } catch (err) {
      this.logger.error("status", `Status ping connection failed: ${errText(err)}`);
      this.setPhase("idle");
      return null;
    }
    this.send("handshake", "toServer", "set_protocol", P.buildHandshake(this.registry.protocolVersion, this.config.host, this.config.port, 1));
    this.sendStatus("ping_start", P.buildStatusRequest());

    const timeout = this.config.timeouts.statusMs;
    const got = await this.waitUntil(
      () => this.statusSettled || this.closedReason !== null,
      timeout,
      "status response",
    );
    const status = got ? this.status : null;
    if (!status) {
      this.logger.warn("status", `No status response within ${timeout}ms — cannot auto-detect version.`);
      this.transport.close("status timeout");
      this.setPhase("idle");
      return null;
    }
    void started;
    return status;
  }

  /** Full login sequence: optional detection, handshake, login, configuration. */
  async connect(): Promise<void> {
    this.connectSettled = false;
    this.closing = false;
    this.closedReason = null;
    this.framer.reset();
    this.finishConfigurationReceived = false;
    this.packBarrierActive = false;
    this.resourcePack.reset();

    // Version negotiation.
    if (this.config.versionMode === "auto" && !this.status) {
      const detectedStatus = await this.detectStatus();
      if (detectedStatus) {
        const detected = detectedStatus.protocol;
        if (detected && detected !== this.config.protocolVersion) {
          this.logger.warn(
            "version",
            `Detected protocol ${detected} (${detectedStatus.versionName}) differs from configured ` +
              `${this.config.protocolVersion} (${this.config.versionName}); using detected protocol.`,
          );
          this.config.protocolVersion = detected;
          if (detectedStatus.versionName) this.config.versionName = detectedStatus.versionName;
        } else {
          this.logger.info(
            "version",
            `Detected protocol ${detected} (${detectedStatus.versionName}) — matches configured target.`,
          );
        }
      } else {
        this.logger.warn(
          "version",
          `Status detection failed; falling back to configured protocol ` +
            `${this.config.protocolVersion} (${this.config.versionName}) rather than guessing.`,
        );
      }
    }

    this.setPhase("login");
    // The status connection may have closed between detection and login;
    // clear any residual close state so waitUntil cannot trip on it.
    this.closing = false;
    this.connectSettled = false;
    this.closedReason = null;
    this.framer.reset();
    try {
      await this.transport.connect();
    } catch (err) {
      this.failConnect(`TCP connect failed: ${errText(err)}`);
      throw err;
    }
    this.startWatchdog();

    const host = this.config.host;
    const port = this.config.port;
    this.logger.info(
      "connection",
      `Handshake -> ${host}:${port} as protocol ${this.registry.protocolVersion} ` +
        `(${this.registry.versionName}), state=login` +
        (this.transport.endpoint !== `${host}:${port}` ? ` via ${this.transport.endpoint}` : ""),
    );
    this.send("handshake", "toServer", "set_protocol", P.buildHandshake(this.registry.protocolVersion, host, port, 2));

    const uuid = offlineUuid(this.config.credentials.username);
    this.logger.info("connection", `Login start as "${this.config.credentials.username}" (offline uuid ${uuid}).`);
    this.sendLogin("login_start", P.buildLoginStart(this.config.credentials.username, uuid));

    const ok = await this.waitUntil(
      () => this.connectSettled || this.closedReason !== null,
      this.config.timeouts.loginMs + this.config.timeouts.configurationMs,
      "login/configuration completion",
    );
    if (!ok || this.closedReason) {
      const reason = this.closedReason ?? "timed out";
      this.stopWatchdog();
      throw new Error(`Connection did not complete: ${reason}`);
    }
    this.stopWatchdog();
    this.startWatchdog(); // keep-alives continue in play
  }

  /** Resolve once the play state is reached. */
  async waitForPlay(timeoutMs = 30000): Promise<boolean> {
    if (this.phaseValue === "play") return true;
    return this.waitUntil(() => this.phaseValue === "play" || this.closedReason !== null, timeoutMs, "play state");
  }

  private waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
    return new Promise((resolve) => {
      const started = this.now();
      const check = () => {
        if (predicate()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (this.now() - started >= timeoutMs) {
          clearInterval(timer);
          this.logger.warn("protocol", `Timed out after ${timeoutMs}ms waiting for ${what}.`);
          resolve(false);
        }
      };
      const timer = setInterval(check, 25);
      check();
    });
  }

  private failConnect(reason: string): void {
    this.logger.error("connection", reason);
    this.connectSettled = true;
    this.closedReason = this.closedReason ?? reason;
  }

  /** Gracefully close with a logged reason. */
  close(reason: string): void {
    this.logger.info("connection", `Closing connection: ${reason}`);
    this.destroy(reason, false);
  }

  private destroy(reason: string, byServer = false): void {
    if (this.closing) return;
    this.closing = true;
    this.closedReason = reason;
    this.stopWatchdog();
    this.connectSettled = true;
    this.statusSettled = true;
    try {
      this.transport.close(reason);
    } catch {
      /* transport already gone */
    }
    this.setPhase("idle");
    this.emit("disconnect", { reason, byServer });
  }

  private onTransportClose(info: { reason: string; error?: boolean }): void {
    if (this.benignClose) {
      this.benignClose = false;
      this.closing = false;
      this.closedReason = null;
      this.connectSettled = false;
      if (this.phaseValue === "status") this.setPhase("idle");
      this.logger.debug("connection", `Status exchange finished: ${info.reason}`);
      return;
    }
    if (this.closing) return;
    this.closing = true;
    const reason = this.closedReason ?? info.reason ?? "connection closed by transport";
    this.closedReason = reason;
    this.stopWatchdog();
    this.connectSettled = true;
    this.setPhase("idle");
    this.logger.warn("connection", `Disconnected: ${reason}`);
    this.emit("disconnect", { reason, byServer: Boolean(info.error) });
  }

  // ------------------------------------------------------------ watchdog

  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastInboundAt = this.now();
    this.watchdog = setInterval(() => this.watchdogTick(), 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private watchdogTick(): void {
    if (this.phaseValue === "idle") return;
    const idleFor = this.now() - this.lastInboundAt;
    if (idleFor > this.keepAliveTimeoutMs) {
      this.logger.error(
        "connection",
        `No inbound packets for ${Math.round(idleFor / 1000)}s (limit ${Math.round(this.keepAliveTimeoutMs / 1000)}s) — ` +
          `assuming dead connection.`,
      );
      this.destroy(`keep-alive timeout after ${Math.round(idleFor / 1000)}s`);
    }
  }

  // ------------------------------------------------------- status handlers

  private statusHandlers: Record<string, (r: MCReader) => void> = {
    server_info: (r) => {
      const json = r.string(32767 * 4);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(json);
      } catch {
        this.logger.warn("status", "Status response was not valid JSON");
      }
      const data = (parsed ?? {}) as Record<string, unknown>;
      const version = (data.version ?? {}) as { name?: string; protocol?: number };
      const players = (data.players ?? {}) as { online?: number; max?: number };
      const descriptionRaw = data.description;
      const description =
        typeof descriptionRaw === "string"
          ? stripFormatting(descriptionRaw)
          : stripFormatting(readComponentFromJsonish(descriptionRaw));
      const status: ServerStatus = {
        host: this.config.host,
        port: this.config.port,
        latencyMs: 0,
        versionName: version.name ?? null,
        protocol: typeof version.protocol === "number" ? version.protocol : null,
        playersOnline: typeof players.online === "number" ? players.online : null,
        playersMax: typeof players.max === "number" ? players.max : null,
        description,
        hasIcon: typeof data.icon === "string",
        enforcesSecureChat: typeof data.enforcesSecureChat === "boolean" ? data.enforcesSecureChat : null,
        detectedAt: this.now(),
        raw: parsed,
      };
      this.status = status;
      this.logger.info(
        "status",
        `Server status: "${status.versionName ?? "?"}" protocol ${status.protocol ?? "?"}, ` +
          `${status.playersOnline ?? "?"}/${status.playersMax ?? "?"} players` +
          (status.description ? `, MOTD "${status.description.slice(0, 80)}"` : ""),
      );
      this.emit("status", status);
      this.sendStatus("ping", P.buildStatusPing(BigInt(this.now())));
    },
    ping: (r) => {
      const time = r.i64();
      if (this.status) {
        this.status.latencyMs = Math.max(0, Number(BigInt.asIntN(64, time)) - Number(BigInt.asIntN(64, BigInt(this.now()))));
        this.emit("status", this.status);
      }
      this.statusSettled = true;
      this.transport.close("status complete");
    },
  };

  // -------------------------------------------------------- login handlers

  private loginHandlers: Record<string, (r: MCReader) => Promise<void> | void> = {
    disconnect: (r) => {
      const reason = readComponent(r);
      this.failConnect(`Server rejected login: ${reason || "(no reason given)"}`);
      this.destroy(`login disconnect: ${reason}`, true);
    },
    compress: (r) => {
      const threshold = r.varint();
      this.codec = { threshold, zlib: this.codec.zlib };
      this.logger.info("protocol", `Compression enabled with threshold ${threshold} bytes.`);
    },
    login_plugin_request: (r) => {
      const messageId = r.varint();
      const channel = r.string();
      this.logger.info("protocol", `Login plugin request on "${channel}" — declining (no plugin channel support).`);
      this.sendLogin("login_plugin_response", P.buildLoginPluginResponse(messageId, null));
    },
    cookie_request: (r) => {
      const name = r.string();
      this.logger.debug("protocol", `Cookie request "${name}" — responding absent.`);
      this.sendLogin("cookie_response", P.buildCookieResponse(name, false));
    },
    encryption_begin: async (r) => {
      await this.handleEncryption(r);
    },
    success: (r) => {
      const uuid = r.uuid();
      const username = r.string();
      this.logger.info("connection", `Login success: "${username}" (${uuid}).`);
      this.sendLogin("login_acknowledged", P.buildLoginAcknowledged());
      this.setPhase("configuration");
      this.emit("loginSuccess", { uuid, username });
      this.sendConfiguration(
        "settings",
        P.buildClientInformation({ locale: "en_us", viewDistance: 8, mainHand: 1 }),
      );
      this.sendConfiguration(
        "custom_payload",
        P.buildPluginMessage("minecraft:brand", encodeBrand("vanilla")),
      );
    },
  };

  private async handleEncryption(r: MCReader): Promise<void> {
    const serverId = r.string();
    const publicKey = r.byteArray();
    const verifyToken = r.byteArray();
    // 1.20.2+ asks whether the client should authenticate with Mojang.
    const shouldAuthenticate = r.remaining > 0 ? r.bool() : true;

    const hasToken = Boolean(this.config.accessToken);
    if (shouldAuthenticate && !hasToken) {
      const message =
        "This server requires ONLINE-MODE authentication (encryption + Mojang session), " +
        "but no access token is configured. Set MC_ACCESS_TOKEN (Termux CLI) or run the " +
        "server in offline mode. Refusing to continue so the failure is explicit.";
      this.logger.error("encryption", message);
      this.emit("error", { context: "encryption", message });
      this.destroy("online-mode server without configured credentials");
      return;
    }

    try {
      const sharedSecret = randomBytes(16);
      const encryptedSecret = rsaPkcs1v15Encrypt(publicKey, sharedSecret);
      const encryptedToken = rsaPkcs1v15Encrypt(publicKey, verifyToken);
      this.sendLogin(
        "encryption_begin",
        P.buildEncryptionResponse(encryptedSecret, encryptedToken),
      );
      // From now on both directions are encrypted (AES-128-CFB8, key = IV = secret).
      this.cipherIn = new AesCfb8(sharedSecret, sharedSecret, "decrypt");
      this.cipherOut = new AesCfb8(sharedSecret, sharedSecret, "encrypt");
      this.logger.info(
        "encryption",
        `Encryption channel established (serverId="${serverId}", authenticate=${shouldAuthenticate}).`,
      );

      if (shouldAuthenticate) {
        const hash = await computeServerHash(serverId, sharedSecret, publicKey);
        await this.joinMojangSession(hash);
      }
    } catch (err) {
      const message = `Encryption failed: ${errText(err)}`;
      this.logger.error("encryption", message);
      this.emit("error", { context: "encryption", message });
      this.destroy(message);
    }
  }

  private async joinMojangSession(serverHash: string): Promise<void> {
    const token = this.config.accessToken;
    const uuid = offlineUuid(this.config.credentials.username);
    const fetchImpl = globalThis.fetch;
    if (!token || !fetchImpl) {
      throw new Error("Mojang join requires an access token and fetch support");
    }
    const response = await fetchImpl("https://sessionserver.mojang.com/session/minecraft/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: token,
        selectedProfile: uuid,
        serverId: serverHash,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Mojang session join failed: HTTP ${response.status} ${body.slice(0, 200)} ` +
          `(in browsers this call is blocked by CORS — use the Termux CLI for online-mode servers)`,
      );
    }
    this.logger.info("encryption", "Mojang session registered for this server hash.");
  }

  // ---------------------------------------------- configuration handlers

  private configurationHandlers: Record<string, (r: MCReader) => Promise<void> | void> = {
    disconnect: (r) => {
      const reason = safeComponent(r);
      this.failConnect(`Kicked during configuration: ${reason}`);
      this.destroy(`configuration disconnect: ${reason}`, true);
    },
    keep_alive: (r) => {
      const id = r.i64();
      this.sendConfiguration("keep_alive", P.buildKeepAlive(id));
    },
    ping: (r) => {
      const id = r.i32();
      this.sendConfiguration("pong", P.buildPong(id));
    },
    finish_configuration: () => {
      this.finishConfigurationReceived = true;
      this.maybeFinishConfiguration();
    },
    select_known_packs: (r) => {
      // Server offers datapack versions; an empty reply makes it send full data.
      const count = r.varint();
      this.logger.debug("configuration", `Server knows ${count} pack(s); replying with none.`);
      this.sendConfiguration("select_known_packs", P.buildKnownPacks([]));
    },
    feature_flags: (r) => {
      const count = r.varint();
      const flags: string[] = [];
      for (let i = 0; i < count; i++) flags.push(r.string());
      const hasVanilla = flags.includes("minecraft:vanilla");
      if (!hasVanilla) {
        this.logger.warn("configuration", `Server enabled non-vanilla feature flags: ${flags.join(", ")}`);
      } else {
        this.logger.debug("configuration", "Feature flags ok (minecraft:vanilla present).");
      }
    },
    registry_data: (r) => {
      const id = r.string();
      const count = r.varint();
      if (id === "minecraft:dimension_type") {
        for (let i = 0; i < count; i++) {
          const key = r.string();
          const present = r.varint() !== 0;
          if (!present) continue;
          try {
            const tag = readNbt(r);
            const compound = tag.type === "compound" ? tag.value : null;
            if (compound) {
              const minY = numberOf(compound.min_y);
              const height = numberOf(compound.height);
              if (minY !== null && height !== null) {
                this.dimensionTypes.set(key, { minY, height });
              }
            }
          } catch (err) {
            this.logger.warn("configuration", `Failed to parse dimension type "${key}": ${errText(err)}`);
            break;
          }
        }
        this.logger.info(
          "configuration",
          `Dimension registry received: ${this.dimensionTypes.size} dimension type(s) ` +
            Object.entries(this.dimensionTypes)
              .slice(0, 4)
              .map(([k, v]) => `${k}(y ${v.minY}..${v.minY + v.height})`)
              .join(", "),
        );
      } else {
        this.logger.debug("configuration", `Registry data "${id}" with ${count} entries (ignored).`);
        // Consume remaining entries so a later handler never misreads bytes.
        for (let i = 0; i < count; i++) {
          r.string();
          if (r.varint() !== 0) readNbt(r);
        }
      }
    },
    tags: (r) => {
      const count = r.varint();
      this.logger.debug("configuration", `Tags: ${count} registries (ignored).`);
      // Tags payload is not needed; remaining bytes are ignored safely.
    },
    custom_payload: (r) => {
      const channel = r.string();
      this.logger.debug("configuration", `Plugin message from "${channel}" (ignored).`);
    },
    add_resource_pack: async (r) => {
      await this.handleResourcePackPush(r, "configuration");
    },
    remove_resource_pack: (r) => {
      const id = r.uuid();
      this.logger.info("resourcepack", `Server removed resource pack ${id}.`);
    },
    store_cookie: (r) => {
      const name = r.string();
      this.logger.debug("configuration", `Cookie stored by server: "${name}" (ignored).`);
    },
    transfer: (r) => {
      const host = r.string();
      const port = r.u16();
      this.logger.warn("configuration", `Server requested transfer to ${host}:${port} — not following.`);
    },
    clear_dialog: () => {
      this.logger.debug("configuration", "Dialog cleared.");
    },
    show_dialog: (r) => {
      this.handleDialog(r);
    },
    code_of_conduct: () => {
      this.logger.info("configuration", "Server sent a code of conduct; accepting.");
      this.sendConfiguration("accept_code_of_conduct", () => {});
    },
  };

  private maybeFinishConfiguration(): void {
    if (!this.finishConfigurationReceived || this.packBarrierActive) return;
    this.sendConfiguration("finish_configuration", P.buildFinishConfiguration());
    this.setPhase("play");
    this.connectSettled = true; // login + configuration completed successfully
    this.logger.info("connection", "Entered PLAY state.");
    // world setup happens in the play `login` handler
  }

  // --------------------------------------------------------------- dialogs

  /**
   * Server-side GUI (1.21.6+ `show_dialog`).
   *
   * The server shows a dialog (`multi_action` with inputs + a custom click
   * action) and waits for the client to answer it. nLogin, for example, asks
   * for a password through a `password1`/`password2` dialog and gates
   * configuration completion on the answer.
   *
   * The bot answers with `custom_click_action` filling the dialog's inputs
   * from its configured password — the same place the login/register secrets
   * already live — so dialog-based auth works exactly like chat/GUI auth
   * elsewhere in the engine.
   */
  private handleDialog(r: MCReader): void {
    const dialog = readNbt(r);
    const compound = dialog.type === "compound" ? dialog.value : undefined;
    if (!compound) {
      this.logger.warn("dialog", "Ignoring malformed show_dialog.");
      return;
    }

        const type = (compound.type?.type === "string" ? compound.type.value : "").toLowerCase();
    const title = nbtToText(compound.title) ?? "";
    const body = nbtToText(compound.body) ?? "";

    this.logger.info(
      "dialog",
      `Server opened dialog: ${title ?? ""} — ${body?.slice(0, 120) ?? ""}`,
    );

    const action = this.dialogAction(compound);
    if (!action) return;

    const keys = this.dialogInputKeys(compound);
    const payload = this.dialogPayload(compound, keys);
    if (payload && Object.values(payload).some((v) => !v)) {
      this.logger.error(
        "dialog",
        "Dialog requires a password configured on the server side (MC_PASSWORD or the dashboard). Aborting dialog submission.",
      );
      return;
    }

    this.sendConfiguration(
      "custom_click_action",
      P.buildCustomClickAction(action.id, payload ?? {}));
  }


  /**
   * Pick the action the bot should answer, preferring an explicit auth target
   * (register/login/stick to the grater action) like the chat auth flow.
   */
  private dialogAction(compound: Record<string, NbtValue>): {
    id: string;
    label: string;
  } | null {
    const actions =
      (compound.actions?.type === "list" ? compound.actions.value : []).map((entry: NbtValue | undefined) => (entry?.type === "compound" ? entry.value : undefined));
    const exitAction = compound.exit_action?.type === "compound" ? compound.exit_action.value : undefined;

    for (const entry of actions) {
      const action = entry?.action?.type === "compound" ? entry.action.value : undefined;
      const label = nbtToText(entry?.label ?? null) ?? "";
      const idValue = action?.id?.type === "string" ? action.id.value : "";
      const id = idValue.toLowerCase();
      if (/register|create|login|log in|sign in|continue|confirm|submit|password/i.test(label) || /register|login|create|password|confirm|continue/i.test(id)) {
        return { id: idValue, label };
      }
    }
    if (exitAction) {
      const label = nbtToText(exitAction?.label ?? null) ?? "";
      const idValue = exitAction?.action?.type === "compound" ? exitAction.action.value.id?.type === "string" ? exitAction.action.value.id.value : "" : "";
      const id = idValue.toLowerCase();
      if (id.includes("exit")) return { id, label };
    }
    return null;
  }

  /**
   * Collect the dialog's input keys so the bot can fill them with the
   * configured password. Only lightweight text inputs are supported; a dialog
   * that asks for anything else keeps the bot from burning secrets.
   */
  private dialogInputKeys(compound: Record<string, NbtValue>): Record<string, string> {
    const keys: Record<string, string> = {};
    const inputs = compound.inputs?.type === "list" ? compound.inputs.value : [];
    for (const entry of inputs) {
      const input = entry?.type === "compound" ? entry.value : undefined;
      const key = input?.key?.type === "string" ? input.key.value : "";
      const type = input?.type?.type === "string" ? input.type.value.toLowerCase() : "";
      const maxLength = input?.max_length;
      if (key && type === "minecraft:text" && maxLength && maxLength.type !== "end" && maxLength.value) {
        keys[key] = "";
      }
    }
    return keys;
  }

  /**
   * Build the NBT payload for the custom click action from the dialog's text
   * inputs. The values come from the server config (the password), never from
   * the browser.
   */
  private dialogPayload(
    compound: Record<string, NbtValue>,
    keys: Record<string, string>,
  ): Record<string, string> | null {
    const credentials = this.config.credentials;
    const password = credentials.password;
    if (!password) return null;

    const inputs = compound.inputs?.type === "list" ? compound.inputs.value : [];
    for (const entry of inputs) {
      const input = entry?.type === "compound" ? entry.value : undefined;
      const key = input?.key?.type === "string" ? input.key.value : "";
      if (key && input?.type?.type === "string" && input.type.value.toLowerCase() === "minecraft:text") {
        // password2 inputs are the same secret as password1 in registration
        // flows; keys ending in "2" or "confirm" reuse the same value.
        keys[key] = password;
      }
    }
    return Object.keys(keys).length > 0 ? keys : null;
  }

  // ------------------------------------------------------- resource packs

  async handleResourcePackPush(r: MCReader, source: "configuration" | "play"): Promise<void> {
    const id = r.uuid();
    const url = r.string();
    const hash = r.string();
    const required = r.bool();
    let prompt: string | undefined;
    if (r.remaining > 0) {
      const present = r.varint() !== 0;
      if (present) prompt = safeComponent(r);
    }
    const request: ResourcePackRequest = {
      id,
      url,
      hash,
      required,
      prompt,
      source,
      receivedAt: this.now(),
    };

    this.packBarrierActive = true;
    let outcome: ResourcePackOutcome;
    try {
      outcome = await this.resourcePack.handle(request);
    } catch (err) {
      outcome = {
        ok: false,
        fatal: required,
        responses: [],
        diagnostic: `Resource pack handler crashed: ${errText(err)}`,
      };
      this.logger.error("resourcepack", outcome.diagnostic!);
    }

    for (const response of outcome.responses) {
      const phase: ConnectionPhase = source;
      this.send(phase, "toServer", "resource_pack_receive", P.buildResourcePackResponse(response.id, response.status));
    }
    this.packBarrierActive = false;
    this.emit("resourcePack", { request, outcome });

    if (outcome.fatal && outcome.diagnostic) {
      this.emit("error", { context: "resourcepack", message: outcome.diagnostic });
      this.destroy(outcome.diagnostic, true);
      return;
    }
    // If finish already arrived while downloading, complete the transition now.
    this.maybeFinishConfiguration();
  }

  // -------------------------------------------------------- play handlers

  private playHandlers = createPlayHandlers(this);

  /** Used by play handlers: parse and store a chunk. */
  ingestChunk(r: MCReader): { cx: number; cz: number } {
    const parsed = parseChunkPacket(r, { decodeStates: true, nonSpanning: true });
    this.world.applyChunk(parsed);
    return { cx: parsed.x, cz: parsed.z };
  }

  /** Next packet sequence number for dig/place acks. */
  nextSequence(): number {
    return this.sequence++;
  }

  /** Display name for a tab-list uuid (or a short fallback). */
  playerNameForUuid(uuid: string): string {
    return this.world.players.get(uuid)?.name ?? uuid.slice(0, 8);
  }

  /** Public close used by play handlers (e.g. kicks). */
  disconnectInternal(reason: string, byServer: boolean): void {
    this.destroy(reason, byServer);
  }

  /** Play -> configuration transition requested by the server. */
  enterConfigurationPhase(): void {
    this.finishConfigurationReceived = false;
    this.setPhase("configuration");
  }

  /** Track an open window from `window_items` payloads. */
  recordWindowItems(
    windowId: number,
    stateId: number,
    slots: (import("../protocol/slots").SlotItem | null)[],
  ): WindowState | null {
    const window = this.world.setWindowItems(windowId, stateId, slots);
    return window;
  }

  describeConnection(): Record<string, unknown> {
    return {
      phase: this.phaseValue,
      host: this.config.host,
      port: this.config.port,
      protocol: this.registry.protocolVersion,
      version: this.registry.versionName,
      encrypted: Boolean(this.cipherIn),
      compressionThreshold: this.codec.threshold,
      endpoint: this.transport.endpoint,
      transport: this.transport.kind,
      idleMs: this.lastInboundAt ? this.now() - this.lastInboundAt : null,
    };
  }
}

// ------------------------------------------------------------- helpers

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeComponent(r: MCReader): string {
  try {
    return readComponent(r);
  } catch (err) {
    return `(unparsable component: ${errText(err)})`;
  }
}

function numberOf(value: NbtValue | undefined): number | null {
  if (!value || !("value" in value)) return null;
  const raw = value.value;
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  return null;
}

function readComponentFromJsonish(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return new TextDecoder().decode(
        new TextEncoder().encode(JSON.stringify(value)),
      );
    } catch {
      return "";
    }
  }
  return String(value ?? "");
}

function encodeBrand(brand: string): Uint8Array {
  const w = new MCWriter(32);
  w.string(brand);
  return w.done();
}

export { nbtToText, readSlotList };
