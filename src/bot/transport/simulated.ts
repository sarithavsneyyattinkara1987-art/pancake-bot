/**
 * Simulated server transport.
 *
 * A scripted implementation of the *real* Minecraft protocol for protocol 774,
 * speaking through the exact same framing/compression/codec path as a live
 * TCP connection. It exists so the web dashboard (browsers cannot open raw TCP
 * sockets) can exercise the full pipeline end-to-end: status/version
 * detection, compression, configuration, resource-pack prompts, login GUIs,
 * chat authentication, chunk loading, pathfinding and movement.
 *
 * It is explicitly labelled "simulated" everywhere it surfaces — the Termux
 * CLI is the path that talks to the real server.
 */
import { Transport } from "./transport";
import { PacketFramer, decodeFrame, encodeFrame, type FrameCodec } from "../protocol/framing";
import { browserZlib, type ZlibCodec } from "../protocol/compression";
import { MCReader, MCWriter, buildPacket } from "../protocol/primitives";

export type SimulationScenario = "gui-login" | "chat-login";

export interface SimulatedTransportOptions {
  host: string;
  port: number;
  scenario?: SimulationScenario;
  /** Pack the simulated server asks for (optional by default). */
  resourcePackRequired?: boolean;
  logger?: {
    debug(scope: string, msg: string): void;
    info(scope: string, msg: string): void;
    warn(scope: string, msg: string): void;
  };
}

const AIR = 0;
const STONE = 1;
const DIRT = 10;
const GRASS = 9;
const COBBLE = 14;

interface Item {
  itemId: number;
  count: number;
  customName?: string;
}

export class SimulatedTransport implements Transport {
  readonly kind = "simulated" as const;
  readonly endpoint: string;

  private readonly options: SimulatedTransportOptions;
  private readonly framer = new PacketFramer();
  private codec: FrameCodec;
  private zlib: ZlibCodec | null = null;
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: ((info: { reason: string; error?: boolean }) => void) | null = null;

  private connected = false;
  private state: "handshake" | "status" | "login" | "configuration" | "play" = "handshake";
  private loginAcknowledged = false;
  private packPushed = false;
  private packResponses = 0;
  private playStarted = false;
  private authenticated = false;
  private windowId = 0;
  private stateId = 1;
  private teleportId = 1;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly playerIdByName = new Map<string, number>();

  constructor(options: SimulatedTransportOptions) {
    this.options = options;
    this.endpoint = `${options.host}:${options.port} (simulated)`;
    this.codec = { threshold: -1, zlib: browserZlib };
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
  }

  onClose(handler: (info: { reason: string; error?: boolean }) => void): void {
    this.closeHandler = handler;
  }

  private log(level: "debug" | "info" | "warn", message: string): void {
    this.options.logger?.[level]("sim", message);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.state = "handshake";
    this.loginAcknowledged = false;
    this.packPushed = false;
    this.packResponses = 0;
    this.playStarted = false;
    this.authenticated = false;
    this.framer.reset();
    this.codec = { threshold: -1, zlib: browserZlib };
    if (typeof CompressionStream !== "undefined") {
      this.zlib = browserZlib;
    }
    this.log("info", "Simulated server accepting connection.");
  }

  send(bytes: Uint8Array): void {
    if (!this.connected) return;
    let frames: Uint8Array[];
    try {
      frames = this.framer.push(bytes);
    } catch (err) {
      this.log("warn", `Framing error: ${errText(err)}`);
      this.close("framing error");
      return;
    }
    for (const frame of frames) {
      void this.handleFrame(frame);
    }
  }

  close(reason = "client closed"): void {
    if (!this.connected) return;
    this.connected = false;
    this.clearTimers();
    this.log("info", `Simulated connection closed: ${reason}`);
    this.closeHandler?.({ reason, error: false });
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private later(fn: () => void, ms: number): void {
    if (!this.connected) return;
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      if (this.connected) fn();
    }, ms);
    this.timers.push(timer);
  }

  private async emit(payload: Uint8Array): Promise<void> {
    if (!this.connected) return;
    try {
      const framed = await encodeFrame(payload, this.codec);
      this.dataHandler?.(framed);
    } catch (err) {
      this.log("warn", `Encode failed: ${errText(err)}`);
    }
  }

  private emitPacket(phase: "status" | "login" | "configuration" | "play", name: string, build: (w: MCWriter) => void): void {
    const id = packetId(phase, name);
    if (id === null) {
      this.log("warn", `Simulator has no id for ${phase}.${name}`);
      return;
    }
    void this.emit(buildPacket(id, build));
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    let payload: Uint8Array;
    try {
      payload = await decodeFrame(frame, this.codec);
    } catch (err) {
      this.log("warn", `Decode failed: ${errText(err)}`);
      return;
    }
    const r = new MCReader(payload);
    const id = r.varint();
    this.dispatch(id, r);
  }

  private dispatch(id: number, r: MCReader): void {
    if (this.state === "handshake") {
      const protocol = r.varint();
      const host = r.string();
      const port = r.u16();
      const intent = r.varint();
      this.log("info", `Handshake: ${host}:${port} protocol ${protocol} intent ${intent}`);
      this.state = intent === 1 ? "status" : "login";
      return;
    }

    if (this.state === "status") {
      if (id === 0x00) {
        this.emitPacket("status", "server_info", (w) => {
          w.string(
            JSON.stringify({
              version: { name: "1.21.11", protocol: 774 },
              players: { online: 11, max: 100, sample: [] },
              description: { text: "PANCAKESMP — The #1 VANILLA SMP (simulated)" },
              enforcesSecureChat: false,
            }),
          );
        });
      } else if (id === 0x01) {
        const time = r.i64();
        this.emitPacket("status", "ping", (w) => w.i64(time));
        this.connected = true; // client closes after status
      }
      return;
    }

    if (this.state === "login") {
      if (id === 0x00) {
        // login_start -> set compression (exercises the codec) -> login success
        const username = r.string();
        r.uuid();
        this.log("info", `Login start as "${username}"`);
        if (this.zlib) {
          this.emitPacket("login", "compress", (w) => w.varint(256));
          this.codec = { threshold: 256, zlib: this.zlib };
        }
        this.emitPacket("login", "success", (w) => {
          w.uuid(offlineStyleUuid(username));
          w.string(username);
          w.varint(0); // property count
        });
      } else if (id === 0x03) {
        this.state = "configuration";
        this.log("info", "Client acknowledged login; entering configuration.");
        this.runConfigurationScript();
      }
      return;
    }

    if (this.state === "configuration") {
      switch (id) {
        case 0x00: // settings (client information)
          this.log("info", "Client information received.");
          break;
        case 0x07: // select_known_packs reply
          this.log("info", "Client reported known packs.");
          break;
        case 0x06: { // resource_pack_receive
          r.uuid();
          const status = r.varint();
          this.packResponses += 1;
          this.log("info", `Resource pack response #${status} (${this.packResponses} received).`);
          if (this.packPushed && this.packResponses >= 1) {
            this.finishConfiguration();
          }
          break;
        }
        case 0x03: // finish_configuration
          this.state = "play";
          this.runPlayScript();
          break;
        default:
          break;
      }
      return;
    }

    // play state
    this.handlePlayPacket(id, r);
  }

  private configurationSent = false;

  private runConfigurationScript(): void {
    if (this.configurationSent) return;
    this.configurationSent = true;

    this.emitPacket("configuration", "select_known_packs", (w) => {
      w.varint(1);
      w.string("minecraft");
      w.string("core");
      w.string("1.21.11");
    });

    this.emitPacket("configuration", "feature_flags", (w) => {
      w.varint(1);
      w.string("minecraft:vanilla");
    });

    this.emitPacket("configuration", "registry_data", (w) => {
      w.string("minecraft:dimension_type");
      w.varint(2);
      // entry 1
      w.string("minecraft:overworld");
      w.varint(1); // present
      w.raw(dimensionNbt(-64, 384));
      // entry 2
      w.string("minecraft:the_nether");
      w.varint(1);
      w.raw(dimensionNbt(0, 256));
    });

    this.later(() => {
      const required = this.options.resourcePackRequired ?? false;
      this.emitPacket("configuration", "add_resource_pack", (w) => {
        w.uuid(packUuid());
        w.string("https://packs.pancakesmp.example/resourcepack.zip");
        w.string(""); // no hash supplied by this simulated server
        w.bool(required);
        w.varint(1); // prompt message present
        w.raw(textComponent(required ? "This pack is required to play." : "Optional pack available."));
      });
      this.packPushed = true;
      this.log("info", `Resource pack pushed (required=${required}); waiting for client response.`);
      // Safety: never hang the demo if the client declines to answer.
      this.later(() => this.finishConfiguration(), 4000);
    }, 250);
  }

  private finishConfiguration(): void {
    if (this.state !== "configuration") return;
    this.emitPacket("configuration", "finish_configuration", () => {});
    this.log("info", "Configuration finished.");
  }

  // ------------------------------------------------------------ play script

  private runPlayScript(): void {
    if (this.playStarted) return;
    this.playStarted = true;
    this.configurationSent = false;

    this.emitPacket("play", "login", (w) => {
      w.i32(42); // entity id
      w.bool(false); // hardcore
      w.varint(1);
      w.string("minecraft:overworld");
      w.varint(100); // max players
      w.varint(8); // view distance
      w.varint(8); // simulation distance
      w.bool(false); // reduced debug
      w.bool(true); // respawn screen
      w.bool(false); // limited crafting
      w.varint(0); // dimension id
      w.string("minecraft:overworld");
      w.i64(0n); // hashed seed
      w.u8(0); // gamemode survival
      w.i8(-1); // previous gamemode
      w.bool(false); // debug
      w.bool(false); // flat
      w.bool(false); // death location
      w.varint(0); // portal cooldown
      w.varint(63); // sea level
      w.bool(false); // enforces secure chat
    });

    this.emitPacket("play", "abilities", (w) => {
      w.i8(0);
      w.f32(0.05);
      w.f32(0.1);
    });

    this.emitPacket("play", "position", (w) => {
      w.varint(this.teleportId++);
      w.f64(0.5);
      w.f64(64);
      w.f64(0.5);
      w.f64(0);
      w.f64(0);
      w.f64(0);
      w.f32(0);
      w.f32(0);
      w.u32(0);
    });

    this.emitPacket("play", "update_health", (w) => {
      w.f32(20);
      w.varint(20);
      w.f32(5);
    });

    this.emitPacket("play", "system_chat", (w) => {
      w.raw(
        textComponent(
          this.options.scenario === "chat-login"
            ? "Welcome to PancakeSMP! Type /login <password> to continue."
            : "Welcome to PancakeSMP! Please authenticate in the dialog.",
        ),
      );
      w.bool(false);
    });

    if (this.options.scenario === "chat-login") {
      this.later(() => this.promptChatAuth(), 4000);
    } else {
      this.later(() => this.openLoginWindow(), 700);
    }

    this.startAmbient();
  }

  private promptChatAuth(): void {
    if (this.authenticated || !this.connected) return;
    this.emitPacket("play", "system_chat", (w) => {
      w.raw(textComponent("You must login with /login <password> before you can play."));
      w.bool(false);
    });
    this.later(() => this.promptChatAuth(), 6000);
  }

  private openLoginWindow(): void {
    if (this.authenticated || !this.connected) return;
    this.windowId = 1;
    this.stateId += 1;
    this.emitPacket("play", "open_window", (w) => {
      w.varint(this.windowId);
      w.varint(2); // generic 3-row chest
      w.raw(textComponent("Authentication required"));
    });

    this.emitPacket("play", "window_items", (w) => {
      w.varint(this.windowId);
      w.varint(this.stateId);
      w.varint(27);
      const slots: (Item | null)[] = new Array(27).fill(null);
      slots[4] = { itemId: 401, count: 1, customName: "Login" };
      slots[22] = { itemId: 402, count: 1, customName: "Register" };
      for (const slot of slots) writeItem(w, slot);
      writeItem(w, null); // carried
    });
    this.log("info", "Login GUI opened (window 1, Login slot 4, Register slot 22).");
  }

  private startAmbient(): void {
    const fakePlayers: Array<{ uuid: string; name: string; x: number; z: number }> = [
      { uuid: uuidFromString("steve"), name: "Steve_Pancake", x: 3, z: 2 },
      { uuid: uuidFromString("alex"), name: "Alex_Chef", x: -4, z: 5 },
    ];

    this.later(() => {
      if (!this.connected) return;
      // Tab list entries
      this.emitPacket("play", "player_info", (w) => {
        w.u8(0x01 | 0x08 | 0x10); // add_player | listed | latency
        w.varint(fakePlayers.length + 1);
        for (const player of fakePlayers) {
          w.uuid(player.uuid);
          w.string(player.name);
          w.varint(0); // properties
          w.varint(1); // listed
          w.varint(34); // ping
        }
        w.uuid(offlineStyleUuid("PancakeBot"));
        w.string("PancakeBot");
        w.varint(0);
        w.varint(1);
        w.varint(12);
      });

      for (const player of fakePlayers) {
        this.playerIdByName.set(player.name, 700 + fakePlayers.indexOf(player));
        this.emitPacket("play", "spawn_entity", (w) => {
          w.varint(this.playerIdByName.get(player.name)!);
          w.uuid(player.uuid);
          w.varint(128); // player entity type in modern registry
          w.f64(player.x + 0.5);
          w.f64(64);
          w.f64(player.z + 0.5);
          w.i16(0);
          w.i16(0);
          w.i16(0);
          w.i8(0);
          w.i8(0);
          w.i8(0);
          w.varint(0);
        });
      }
      // one mob for entity variety
      this.emitPacket("play", "spawn_entity", (w) => {
        w.varint(640);
        w.uuid(uuidFromString("zombie1"));
        w.varint(45); // zombie-ish
        w.f64(6.5);
        w.f64(64);
        w.f64(-3.5);
        w.i16(0);
        w.i16(0);
        w.i16(0);
        w.i8(0);
        w.i8(0);
        w.i8(0);
        w.varint(0);
      });
      this.log("info", "Spawned 2 players and 1 mob in view.");
    }, 250);

    this.later(() => {
      if (!this.connected) return;
      this.sendWorld();
    }, 450);

    let tick = 0;
    this.ticker = setInterval(() => {
      if (!this.connected) return;
      tick += 1;

      if (tick % 4 === 0) {
        this.emitPacket("play", "keep_alive", (w) => w.i64(BigInt(Date.now())));
      }

      if (tick % 5 === 1 && fakePlayers.length > 0) {
        const lines = [
          "anyone got pancakes?",
          "spawn is looking good today",
          "brb, chopping wood",
          "the nether portal is at -120/64/300",
        ];
        const player = fakePlayers[tick % fakePlayers.length];
        this.emitPacket("play", "system_chat", (w) => {
          w.raw(textComponent(`<${player.name}> ${lines[tick % lines.length]}`));
          w.bool(false);
        });
      }

      if (tick % 7 === 3) {
        // entity movement
        const dx = 0.2 * 4096;
        this.emitPacket("play", "rel_entity_move", (w) => {
          w.varint(640);
          w.i16(dx);
          w.i16(0);
          w.i16(0);
          w.bool(true);
        });
      }

      if (tick % 12 === 5) {
        // block update near spawn to exercise block tracking
        this.emitPacket("play", "block_change", (w) => {
          w.position(2, 64, 2);
          w.varint(tick % 24 === 5 ? COBBLE : AIR);
        });
      }

      if (tick % 12 === 8) {
        // gentle nudge teleport to exercise teleport confirmation
        this.emitPacket("play", "position", (w) => {
          w.varint(this.teleportId++);
          w.f64(0.5);
          w.f64(64);
          w.f64(0.5);
          w.f64(0);
          w.f64(0);
          w.f64(0);
          w.f32(0);
          w.f32(0);
          w.u32(0);
        });
      }
    }, 1000);
  }

  private sendWorld(): void {
    if (!this.connected) return;
    this.emitPacket("play", "chunk_batch_start", () => {});
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        this.emitPacket("play", "map_chunk", (w) => {
          w.i32(cx);
          w.i32(cz);
          w.varint(0); // heightmaps: none
          const chunkData = encodeFlatChunk();
          w.byteArray(chunkData);
          w.varint(0); // block entities
          w.varint(0); // sky light mask
          w.varint(0); // block light mask
          w.varint(0); // empty sky light mask
          w.varint(0); // empty block light mask
          w.varint(0); // sky light arrays
          w.varint(0); // block light arrays
        });
      }
    }
    this.emitPacket("play", "chunk_batch_finished", (w) => w.varint(9));
    this.log("info", "Sent 3x3 chunk grid around spawn.");
  }

  private handlePlayPacket(id: number, r: MCReader): void {
    switch (id) {
      case 0x1b: { // keep_alive
        r.i64();
        break;
      }
      case 0x1d:
      case 0x1e:
      case 0x1f:
      case 0x20: // movement family
      case 0x0c: // tick_end
      case 0x2b: // player_loaded
        break;
      case 0x00: // teleport_confirm
        r.varint();
        break;
      case 0x06: { // chat_command (no leading slash)
        const command = r.string();
        this.handleCommand(command);
        break;
      }
      case 0x08: { // chat_message
        const message = r.string();
        this.emitPacket("play", "system_chat", (w) => {
          w.raw(textComponent(`<PancakeBot> ${message}`));
          w.bool(false);
        });
        break;
      }
      case 0x11: { // window_click
        const windowId = r.varint();
        r.varint(); // state id
        const slot = r.i16();
        this.handleClick(windowId, slot);
        break;
      }
      case 0x0a: // chunk_batch_received
        r.f32();
        break;
      case 0x28: { // block_dig
        const status = r.varint();
        const pos = r.position();
        r.i8(); // face
        const sequence = r.varint();
        if (status === 2 || status === 0) {
          this.emitPacket("play", "acknowledge_player_digging", (w) => w.varint(sequence));
        }
        if (status === 2) {
          // creative-style instant break for the demo
          this.emitPacket("play", "block_change", (w) => {
            w.position(pos.x, pos.y, pos.z);
            w.varint(AIR);
          });
        }
        break;
      }
      case 0x3f: { // block_place
        r.varint(); // hand
        const pos = r.position();
        r.varint(); // face
        r.f32();
        r.f32();
        r.f32();
        r.bool();
        r.bool();
        const sequence = r.varint();
        this.emitPacket("play", "acknowledge_player_digging", (w) => w.varint(sequence));
        this.emitPacket("play", "block_change", (w) => {
          w.position(pos.x, pos.y, pos.z);
          w.varint(COBBLE);
        });
        break;
      }
      default:
        break;
    }
  }

  private handleCommand(command: string): void {
    const [name, ...args] = command.split(" ");
    if (name === "login" || name === "register") {
      if (args.length === 0 || !args[0]) {
        this.emitPacket("play", "system_chat", (w) => {
          w.raw(textComponent(`Usage: /${name} <password>`));
          w.bool(false);
        });
        return;
      }
      this.grantAccess(name === "register" ? "registered and logged in" : "logged in");
      return;
    }
    if (name === "list") {
      this.emitPacket("play", "system_chat", (w) => {
        w.raw(textComponent("There are 3/100 players online: Steve_Pancake, Alex_Chef, PancakeBot"));
        w.bool(false);
      });
      return;
    }
    this.emitPacket("play", "system_chat", (w) => {
      w.raw(textComponent(`Simulated server: unknown command "/${name}"`));
      w.bool(false);
    });
  }

  private handleClick(windowId: number, slot: number): void {
    if (windowId !== this.windowId) return;
    if (slot !== 4 && slot !== 22) {
      this.emitPacket("play", "system_chat", (w) => {
        w.raw(textComponent("Please click the Login button."));
        w.bool(false);
      });
      return;
    }
    this.emitPacket("play", "close_window", (w) => w.varint(windowId));
    this.grantAccess(slot === 22 ? "registered and logged in" : "logged in");
  }

  private grantAccess(what: string): void {
    if (this.authenticated) return;
    this.authenticated = true;
    this.emitPacket("play", "system_chat", (w) => {
      w.raw(textComponent(`Successfully ${what}! Welcome back.`));
      w.bool(false);
    });
    this.emitPacket("play", "set_title_text", (w) => w.raw(textComponent("Welcome to PancakeSMP!")));
    if (!this.playStarted) return;
    this.log("info", `Access granted (${what}).`);
  }
}

// ------------------------------------------------------------ helpers

function packetId(phase: "status" | "login" | "configuration" | "play", name: string): number | null {
  const tables: Record<string, Record<string, number>> = {
    status: {
      server_info: 0x00,
      ping: 0x01,
    },
    login: {
      compress: 0x03,
      success: 0x02,
      disconnect: 0x00,
      encryption_begin: 0x01,
    },
    configuration: {
      select_known_packs: 0x0e,
      feature_flags: 0x0c,
      registry_data: 0x07,
      add_resource_pack: 0x09,
      finish_configuration: 0x03,
      keep_alive: 0x04,
      disconnect: 0x02,
    },
    play: {
      login: 0x30,
      abilities: 0x3e,
      position: 0x46,
      update_health: 0x66,
      system_chat: 0x77,
      player_chat: 0x3f,
      player_info: 0x44,
      spawn_entity: 0x01,
      rel_entity_move: 0x33,
      entity_destroy: 0x4b,
      map_chunk: 0x2c,
      chunk_batch_start: 0x0c,
      chunk_batch_finished: 0x0b,
      block_change: 0x08,
      keep_alive: 0x2b,
      open_window: 0x39,
      close_window: 0x11,
      window_items: 0x12,
      set_slot: 0x14,
      respawn: 0x50,
      set_title_text: 0x70,
      acknowledge_player_digging: 0x04,
      kick_disconnect: 0x20,
      update_view_position: 0x5c,
    },
  };
  return tables[phase]?.[name] ?? null;
}

function textComponent(text: string): Uint8Array {
  // Plaintext component = single NBT string tag (type 0x08, u16 length).
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(3 + encoded.byteLength);
  out[0] = 0x08;
  out[1] = (encoded.byteLength >> 8) & 0xff;
  out[2] = encoded.byteLength & 0xff;
  out.set(encoded, 3);
  return out;
}

function dimensionNbt(minY: number, height: number): Uint8Array {
  const w = new MCWriter(64);
  w.u8(0x0a); // compound (anonymous: no root name)
  // int min_y
  w.u8(0x03);
  writeNbtName(w, "min_y");
  w.i32(minY);
  // int height
  w.u8(0x03);
  writeNbtName(w, "height");
  w.i32(height);
  // byte skylight
  w.u8(0x01);
  writeNbtName(w, "skylight");
  w.i8(1);
  w.u8(0x00); // end
  return w.done();
}

function writeNbtName(w: MCWriter, name: string): void {
  const encoded = new TextEncoder().encode(name);
  w.u16(encoded.byteLength);
  w.raw(encoded);
}

function writeItem(w: MCWriter, item: Item | null): void {
  if (!item) {
    w.varint(0);
    return;
  }
  w.varint(item.count);
  w.varint(item.itemId);
  w.varint(item.customName ? 1 : 0); // added components
  w.varint(0); // removed components
  if (item.customName) {
    w.varint(6); // custom_name component type id
    w.raw(textComponent(item.customName));
  }
}

/** All-air sections above ground, dirt/grass/stone below (single-value palettes). */
function encodeFlatChunk(): Uint8Array {
  const w = new MCWriter(1024);
  // 24 sections for y -64..319 (overworld)
  for (let sectionIndex = 0; sectionIndex < 24; sectionIndex++) {
    const sectionY = -64 + sectionIndex * 16;
    let paletteId = AIR;
    let blockCount = 0;
    if (sectionY <= 0) {
      paletteId = sectionY === -64 ? 85 : STONE; // bedrock at the bottom
      blockCount = 4096;
    } else if (sectionY <= 16) {
      paletteId = DIRT;
      blockCount = 4096;
    } else if (sectionY <= 48) {
      paletteId = sectionY === 48 ? GRASS : DIRT;
      blockCount = 4096;
    } else {
      paletteId = AIR;
      blockCount = 0;
    }
    w.u16(blockCount);
    // block states: single-value palette
    w.u8(0);
    w.varint(paletteId);
    // biomes: single-value palette
    w.u8(0);
    w.varint(1); // plains
  }
  return w.done();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function offlineStyleUuid(username: string): string {
  // Deterministic pseudo-uuid for the simulation (not the real offline UUID;
  // the real derivation lives in protocol/uuid.ts and is unit-tested there).
  let hash = 0x811c9dc5;
  for (let i = 0; i < username.length; i++) {
    hash ^= username.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `00000000-0000-3000-8000-${hex.padStart(12, "0")}`;
}

function uuidFromString(seed: string): string {
  return offlineStyleUuid(seed);
}

let packCounter = 0;
function packUuid(): string {
  packCounter += 1;
  return `b0000000-0000-4000-8000-${String(packCounter).padStart(12, "0")}`;
}
