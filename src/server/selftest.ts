/**
 * Backend self-test.
 *
 *   bun src/server/selftest.ts
 *   SELFTEST_CONNECT=1 bun src/server/selftest.ts   # also attempt a real login
 *
 * Verifies, against a real bridge process:
 *   1. /health answers without auth
 *   2. /api/state and /api/command reject a missing/wrong token (401)
 *   3. the token authenticates REST command forwarding
 *   4. the WebSocket rejects a bad token and accepts the real one
 *   5. commands sent over the socket execute on the bot and stream back
 *   6. snapshots and logs stream to the phone
 *   7. rate limiting actually rejects a flood
 *   8. the configured Minecraft target resolves and accepts a raw TCP connection
 *      (the real IP/port used is reported; the configured address is unchanged)
 *
 * Nothing is faked: a network failure is printed as the actual error.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { BotRuntime } from "./runtime";
import { createBridgeServer } from "./bridge";
import type { BridgeMessage } from "../lib/bridgeProtocol";

const TOKEN = "selftest-token";
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

async function http(
  url: string,
  init?: { method?: string; token?: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (init?.token) headers.Authorization = `Bearer ${init.token}`;
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** Raw TCP reachability probe (SRV-aware, exactly like the client transport). */
async function probeMinecraft(
  host: string,
  port: number,
): Promise<{ target: string; connected: boolean; error?: string; srv?: string }> {
  let targetHost = host;
  let targetPort = port;
  let srv: string | undefined;
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (records.length > 0) {
      const record = [...records].sort((a, b) => a.priority - b.priority)[0];
      targetHost = record.name;
      targetPort = record.port;
      srv = `${record.name}:${record.port}`;
    }
  } catch (err) {
    srv = `no SRV record (${(err as Error).message})`;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: targetHost, port: targetPort });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ target: `${targetHost}:${targetPort}`, connected: false, error: "connect timeout (6s)", srv });
    }, 6000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ target: `${targetHost}:${targetPort}`, connected: true, srv });
    });
    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ target: `${targetHost}:${targetPort}`, connected: false, error: err.message, srv });
    });
  });
}

/** Connect a WebSocket client, resolving on open or rejecting on failure. */
function socket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    // Keep the listener attached: a failed handshake can emit more than one
    // error event, and an unhandled 'error' event would kill the process.
    ws.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    ws.on("open", () => {
      if (settled) return;
      settled = true;
      resolve(ws);
    });
  });
}

async function main(): Promise<void> {
  const runtime = new BotRuntime({ env: process.env });
  const bridge = createBridgeServer({ runtime, token: TOKEN, host: "127.0.0.1", port: 0 });
  const port = await bridge.listen();
  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  process.stdout.write(`\nBridge self-test on port ${port} (target ${runtime.target})\n`);

  try {
    section("HTTP surface");
    const health = await http(`${httpBase}/health`);
    check("/health is public", health.status === 200 && health.body.ok === true, JSON.stringify(health.body));
    check(
      "/health reports the configured target",
      health.body.target === runtime.target,
      String(health.body.target),
    );

    const unauth = await http(`${httpBase}/api/state`);
    check("unauthenticated /api/state is rejected", unauth.status === 401, `status ${unauth.status}`);

    const wrongToken = await http(`${httpBase}/api/state`, { token: "nope" });
    check("wrong token is rejected", wrongToken.status === 401, `status ${wrongToken.status}`);

    const state = await http(`${httpBase}/api/state`, { token: TOKEN });
    check(
      "authenticated /api/state returns settings + snapshot",
      state.status === 200 && typeof state.body.settings === "object" && typeof state.body.snapshot === "object",
      `status ${state.status}`,
    );

    section("Command forwarding over REST");
    const help = await http(`${httpBase}/api/command`, { method: "POST", token: TOKEN, body: { input: "help" } });
    const helpLines = (help.body.lines as string[]) ?? [];
    check("help lists the documented verbs", help.body.ok === true && helpLines.some((l) => l.includes("connect")), `${helpLines.length} lines`);

    const bogus = await http(`${httpBase}/api/command`, { method: "POST", token: TOKEN, body: { input: "sudo rm -rf /" } });
    check("unknown/shell-ish input is rejected server-side", bogus.body.ok === false, String(bogus.body.lines));

    section("WebSocket authentication");
    let badRejected = false;
    try {
      const bad = await socket(`${wsBase}/ws?token=wrong`);
      bad.close();
    } catch (err) {
      badRejected = true;
      check("socket with a bad token is refused", true, (err as Error).message);
    }
    if (!badRejected) check("socket with a bad token is refused", false, "connection was accepted");

    const ws = await socket(`${wsBase}/ws?token=${TOKEN}`);
    check("socket with the real token opens", true);

    let hello: BridgeMessage | null = null;
    let sawSnapshot = false;
    let sawLog = false;
    const commandResults = new Map<string, { ok: boolean; lines: string[] }>();
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as BridgeMessage;
      if (message.type === "hello") hello = message;
      if (message.type === "snapshot") sawSnapshot = true;
      if (message.type === "log") sawLog = true;
      if (message.type === "commandResult") commandResults.set(message.id, { ok: message.ok, lines: message.lines });
    });

    await delay(300);
    check("hello frame received", hello !== null, hello ? `target ${(hello as BridgeMessage & { target: string }).target}` : "");

    ws.send(JSON.stringify({ type: "command", id: "cmd-status", input: "status" }));
    ws.send(JSON.stringify({ type: "command", id: "cmd-bogus", input: "fly me to the moon" }));
    await delay(500);

    const statusResult = commandResults.get("cmd-status");
    check(
      "socket command executed on the bot",
      Boolean(statusResult && statusResult.lines.length > 0),
      statusResult ? `${statusResult.lines.length} lines` : "no result",
    );
    check(
      "status reports no connection (honest, not faked)",
      Boolean(statusResult && statusResult.lines.some((l) => l.includes("not connected"))),
    );

    const bogusResult = commandResults.get("cmd-bogus");
    check("socket rejects an unknown verb", bogusResult?.ok === false);

    await delay(1200);
    check("snapshots stream to the phone", sawSnapshot);
    check("logs stream to the phone", sawLog);

    section("Rate limiting");
    for (let i = 0; i < 40; i += 1) {
      ws.send(JSON.stringify({ type: "command", id: `flood-${i}`, input: "say rate limit probe" }));
    }
    await delay(1200);
    const limited = [...commandResults.values()].some((r) => r.lines.some((l) => l.toLowerCase().includes("rate limited")));
    check("command flood is rate limited", limited, `${commandResults.size} results`);
    ws.close();

    section("Real Minecraft reachability");
    const host = runtime.settingsView() && process.env.MC_HOST ? process.env.MC_HOST : "pancakesmp.kinetic.host";
    const portValue = Number.parseInt(process.env.MC_PORT ?? "25565", 10);
    process.stdout.write(`  probing ${host}:${portValue} …\n`);
    const probe = await probeMinecraft(host, portValue);
    process.stdout.write(`  SRV       : ${probe.srv ?? "none"}\n`);
    process.stdout.write(`  TCP target: ${probe.target}\n`);
    if (probe.connected) {
      check(`TCP connection to ${probe.target} succeeds`, true);
    } else {
      check(
        `TCP connection to ${probe.target}`,
        false,
        `${probe.error ?? "unknown error"} (network may be blocked in this sandbox — the bot surfaces this exact error)`,
      );
    }

    if (/^(1|true|yes)$/i.test(process.env.SELFTEST_CONNECT ?? "")) {
      section("Live login attempt (SELFTEST_CONNECT=1)");
      process.stdout.write("  sending connect to the real bot …\n");
      const outcome = await runtime.command("connect", "selftest");
      process.stdout.write(`  ${outcome.lines.join("\n  ")}\n`);
      let activity = "";
      let phase = "idle";
      let shown = "";
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await delay(1000);
        const snapshot = runtime.snapshot();
        activity = snapshot.activity;
        phase = snapshot.connection ? String(snapshot.connection.phase) : "idle";
        const label = `${activity}/${phase}`;
        if (label !== shown) {
          shown = label;
          process.stdout.write(`  … ${label}\n`);
        }
        if (phase === "play") break;
        if (snapshot.stats.lastError) break;
      }
      const snapshot = runtime.snapshot();
      process.stdout.write(`  activity=${snapshot.activity} phase=${phase}\n`);
      process.stdout.write(`  lastError=${snapshot.stats.lastError ?? "none"}\n`);
      process.stdout.write("  last log lines:\n");
      for (const entry of runtime.recentLogs(200).slice(-30)) {
        process.stdout.write(`    [${entry.level}] ${entry.scope}: ${entry.message}\n`);
      }
      check(
        "live login reached a real protocol phase",
        phase === "play",
        `phase ${phase}, error ${snapshot.stats.lastError ?? "none"}`,
      );
      runtime.command("disconnect selftest", "selftest");
    }
  } finally {
    runtime.stop();
    await bridge.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length > 0 ? `\nFailures:\n${failed.map((f) => `  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`).join("\n")}\n` : "\n"),
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
