/**
 * Raw TCP transport for the Node/Termux CLI.
 *
 * Endpoint resolution mirrors what a vanilla Minecraft client does when you
 * type `pancakesmp.kinetic.host:25565`:
 *
 *   1. if the configured port is the default (25565) and `resolveSrv` is on,
 *      look up `_minecraft._tcp.<host>`; a SRV answer names the real endpoint
 *      and port (this is standard client behaviour, and it is logged loudly —
 *      the configured target is never silently rewritten)
 *   2. otherwise connect to the host's A record on the configured port
 *
 * The configured host/port are always what is sent in the handshake, so
 * virtual-hosting and server logs see exactly `pancakesmp.kinetic.host:25565`.
 */
import net from "node:net";
import dns from "node:dns/promises";
import { Transport, TransportError } from "./transport";

export interface TcpTransportOptions {
  host: string;
  port: number;
  /** Look up _minecraft._tcp SRV records (vanilla behaviour). */
  resolveSrv?: boolean;
  connectTimeoutMs?: number;
  logger?: { info(scope: string, msg: string): void; warn(scope: string, msg: string): void };
}

export class TcpTransport implements Transport {
  readonly kind = "tcp" as const;
  readonly endpoint: string;

  private socket: net.Socket | null = null;
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: ((info: { reason: string; error?: boolean }) => void) | null = null;
  private closed = false;
  private readonly options: TcpTransportOptions;
  private effectiveHost: string;
  private effectivePort: number;

  constructor(options: TcpTransportOptions) {
    this.options = options;
    this.effectiveHost = options.host;
    this.effectivePort = options.port;
    this.endpoint = `${options.host}:${options.port}`;
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
  }

  onClose(handler: (info: { reason: string; error?: boolean }) => void): void {
    this.closeHandler = handler;
  }

  private async resolveTarget(): Promise<{ host: string; port: number; note: string | null }> {
    const { host, port, resolveSrv } = this.options;
    if (resolveSrv && port === 25565) {
      try {
        const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
        if (records.length > 0) {
          const record = [...records].sort((a, b) => a.priority - b.priority)[0];
          return {
            host: record.name,
            port: record.port,
            note:
              `SRV _minecraft._tcp.${host} -> ${record.name}:${record.port} ` +
              `(standard client resolution; handshake still announces ${host}:${port})`,
          };
        }
      } catch (err) {
        this.options.logger?.info(
          "connection",
          `No SRV record for _minecraft._tcp.${host} (${(err as Error).message}); using A record.`,
        );
      }
    }
    return { host, port, note: null };
  }

  async connect(): Promise<void> {
    this.closed = false;
    const target = await this.resolveTarget();
    this.effectiveHost = target.host;
    this.effectivePort = target.port;
    if (target.note) this.options.logger?.info("connection", target.note);
    this.options.logger?.info(
      "connection",
      `TCP connect -> ${target.host}:${target.port} (configured target ` +
        `${this.options.host}:${this.options.port})`,
    );

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: target.host, port: target.port });
      const timeoutMs = this.options.connectTimeoutMs ?? 10000;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new TransportError(`Connect timeout after ${timeoutMs}ms to ${target.host}:${target.port}`));
      }, timeoutMs);

      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        this.dataHandler?.(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });

      socket.on("error", (err: Error) => {
        this.options.logger?.warn("connection", `Socket error: ${err.message}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new TransportError(`Connect failed: ${err.message}`));
          return;
        }
        this.fireClose(`socket error: ${err.message}`, true);
      });

      socket.on("close", () => {
        clearTimeout(timer);
        this.fireClose(this.closed ? "closed locally" : "closed by remote", !this.closed);
      });
    });
  }

  private fireClose(reason: string, error: boolean): void {
    if (!this.closeHandler) return;
    const handler = this.closeHandler;
    this.closeHandler = null;
    this.socket = null;
    handler({ reason, error });
  }

  send(bytes: Uint8Array): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(bytes);
  }

  close(reason = "client close"): void {
    this.closed = true;
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    void reason;
  }
}
