/**
 * Bot backend entry point.
 *
 *   bun src/server/index.ts          # or: npx tsx src/server/index.ts
 *
 * Opens the real Minecraft TCP connection itself and exposes an authenticated
 * HTTPS + WebSocket bridge for the phone dashboard. The phone is only a remote
 * control: it never opens a socket to Minecraft and never receives the
 * Minecraft password.
 *
 * Environment:
 *   BRIDGE_PORT        listening port                (default 8787)
 *   BRIDGE_HOST        listening interface           (default 0.0.0.0)
 *   BRIDGE_TOKEN       dashboard access token        (generated + printed if unset)
 *   BRIDGE_ORIGINS     comma-separated allowed CORS origins (default *)
 *   BRIDGE_AUTOCONNECT connect to Minecraft on boot  (default off)
 *   MC_HOST / MC_PORT  Minecraft target              (default pancakesmp.kinetic.host:25565)
 *   MC_USERNAME        bot account name              (default PancakeBot)
 *   MC_PASSWORD        chat/GUI auth password        (server-side only, never sent to the phone)
 *   MC_PASSWORD2, MC_LOGIN_COMMAND, MC_REGISTER_COMMAND, RESOURCE_PACK_POLICY, ...
 */
import crypto from "node:crypto";
import { BotRuntime } from "./runtime";
import { createBridgeServer } from "./bridge";

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

const port = Number.parseInt(process.env.BRIDGE_PORT ?? "8787", 10);
const host = process.env.BRIDGE_HOST ?? "0.0.0.0";
const configuredToken = (process.env.BRIDGE_TOKEN ?? "").trim();
const generatedToken = configuredToken.length === 0;
const token = configuredToken || crypto.randomBytes(24).toString("base64url");

const runtime = new BotRuntime({ env: process.env, autoConnect: envFlag("BRIDGE_AUTOCONNECT") });
const bridge = createBridgeServer({
  runtime,
  token,
  origins: process.env.BRIDGE_ORIGINS,
  host,
  port,
});

const actualPort = await bridge.listen();

const lines = [
  "",
  "  PancakeBot bridge is listening",
  `  ─────────────────────────────────────────────`,
  `  WebSocket : ws://<this-host>:${actualPort}/ws?token=<token>`,
  `  REST      : http://<this-host>:${actualPort}/api/state`,
  `  Health    : http://<this-host>:${actualPort}/health`,
  `  MC target : ${runtime.target}  (configured address is announced verbatim)`,
  `  Password  : ${runtime.settingsView().hasPassword ? "configured (server-side only)" : "NOT configured — set MC_PASSWORD"}`,
  `  Auth      : ${generatedToken ? "generated token below" : "BRIDGE_TOKEN from environment"}`,
];
if (generatedToken) {
  lines.push(`  Token     : ${token}`, "", "  Paste the token into the dashboard's Bot settings.", "");
} else {
  lines.push("", "  Paste the token into the dashboard's Bot settings.", "");
}
if (!runtime.settingsView().hasPassword) {
  lines.push(
    "  Note: most servers require a password — start with MC_PASSWORD=... so the bot can log in,",
    "        or set it once from the dashboard (it is never stored in the browser).",
    "",
  );
}
process.stdout.write(`${lines.join("\n")}\n`);

const shutdown = (signal: string): void => {
  process.stdout.write(`\nReceived ${signal}; disconnecting the bot.\n`);
  runtime.stop();
  void bridge.close().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
