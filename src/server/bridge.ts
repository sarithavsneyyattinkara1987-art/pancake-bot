/**
 * Bridge server: authenticated HTTPS + WebSocket surface in front of BotRuntime.
 *
 *   phone browser  ──WSS/HTTPS──▶  bridge  ──raw TCP──▶  pancakesmp.kinetic.host:25565
 *
 * Security model:
 *   - every WebSocket upgrade and every /api/* call must present the bridge
 *     token (`BRIDGE_TOKEN`, generated and printed at startup when unset),
 *   - the token is compared in constant time,
 *   - commands are sanitized and rate-limited inside BotRuntime; there is no
 *     shell execution path anywhere in this process,
 *   - Minecraft passwords are only ever accepted (never returned) and are
 *     registered with the redaction layer.
 *
 * Runs on both Bun and Node (`node:http` + `ws`).
 */
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { BotRuntime } from "./runtime";
import { BRIDGE_VERSION, type BridgeMessage, type BridgeRequest } from "../lib/bridgeProtocol";

export interface BridgeOptions {
  runtime: BotRuntime;
  token: string;
  origins?: string;
  host?: string;
  port?: number;
}

export interface BridgeServer {
  server: http.Server;
  /** Listen on the resolved port; resolves with the actual port (0 -> ephemeral). */
  listen(): Promise<number>;
  close(): Promise<void>;
  token: string;
  url: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function readJsonBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error("Payload too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBridgeServer(options: BridgeOptions): BridgeServer {
  const { runtime, token } = options;
  const allowedOrigins = (options.origins ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const corsHeaders = (origin: string | undefined): Record<string, string> => {
    const allow =
      allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin)) ? origin ?? "*" : "";
    return {
      "Access-Control-Allow-Origin": allow || allowedOrigins[0] || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  };

  function sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    origin: string | undefined,
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    });
    res.end(payload);
  }

  function authorized(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const candidate = bearer || url.searchParams.get("token") || "";
    return candidate.length > 0 && constantTimeEquals(candidate, token);
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const stats = runtime.stats();
      sendJson(
        res,
        200,
        { ok: true, version: BRIDGE_VERSION, target: stats.target, activity: stats.activity, uptimeMs: stats.uptimeMs, clients: stats.clients },
        origin,
      );
      return;
    }

    if (url.pathname.startsWith("/api/") && !authorized(req, url)) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" }, origin);
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(
          res,
          200,
          {
            ok: true,
            version: BRIDGE_VERSION,
            target: runtime.target,
            settings: runtime.settingsView(),
            config: runtime.configView(),
            snapshot: runtime.snapshot(),
            logs: runtime.recentLogs(),
          },
          origin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/command") {
        const body = (await readJsonBody(req)) as { input?: unknown };
        const outcome = await runtime.command(body.input, "http");
        sendJson(res, 200, { ok: outcome.ok, lines: outcome.lines, snapshot: runtime.snapshot() }, origin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = (await readJsonBody(req)) as { settings?: Record<string, unknown>; password?: unknown };
        const password = typeof body.password === "string" && body.password.length > 0 ? body.password : undefined;
        const result = runtime.applySettings(body.settings ?? {}, password);
        sendJson(res, 200, { ok: true, problems: result.problems, settings: result.settings, snapshot: runtime.snapshot() }, origin);
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: message }, origin);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" }, origin);
  }

  /* --------------------------------------------------------------- websocket */

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let connectionSeq = 0;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const candidate = url.searchParams.get("token") ?? "";
    if (!candidate || !constantTimeEquals(candidate, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    connectionSeq += 1;
    const callerKey = `ws:${connectionSeq}`;
    const send = (message: BridgeMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    send({
      type: "hello",
      version: BRIDGE_VERSION,
      target: runtime.target,
      settings: runtime.settingsView(),
      config: runtime.configView(),
      snapshot: runtime.snapshot(),
      logs: runtime.recentLogs(),
      at: Date.now(),
    });

    const unsubscribe = runtime.subscribe(send);

    ws.on("message", (data) => {
      void (async () => {
        let request: BridgeRequest;
        try {
          request = JSON.parse(String(data)) as BridgeRequest;
        } catch {
          send({ type: "error", message: "Malformed message" });
          return;
        }

        if (request?.type === "ping") {
          send({ type: "pong", at: Date.now() });
          return;
        }

        if (request?.type === "command") {
          const id = typeof request.id === "string" ? request.id.slice(0, 64) : crypto.randomUUID();
          const outcome = await runtime.command(request.input, callerKey);
          send({ type: "commandResult", id, ok: outcome.ok, lines: outcome.lines });
          send({ type: "snapshot", snapshot: runtime.snapshot() });
          return;
        }

        send({ type: "error", message: "Unsupported message type" });
      })();
    });

    const cleanup = (): void => {
      unsubscribe();
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  let actualPort = port;

  return {
    server,
    token,
    get url() {
      return `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`;
    },
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address && typeof address === "object") actualPort = address.port;
          resolve(actualPort);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    },
  };
}
