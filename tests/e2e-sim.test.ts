/**
 * End-to-end test: the real MinecraftClient + Bot against the scripted
 * protocol-774 SimulatedTransport. Exercises the entire pipeline:
 * status/version detection -> handshake -> login -> compression ->
 * configuration (registry, resource pack) -> play -> GUI authentication ->
 * chunks, tab list, chat, health.
 */
import { describe, expect, test } from "bun:test";
import { Bot } from "../src/bot/core/bot";
import { BotLogger } from "../src/bot/core/logger";
import { DEFAULT_CONFIG, mergeConfig } from "../src/bot/core/config";
import { SimulatedTransport } from "../src/bot/transport/simulated";

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  step = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return predicate();
}

describe("end-to-end against the simulated server", () => {
  test(
    "connects, configures, loads the world and authenticates through the GUI",
    async () => {
      const config = mergeConfig(DEFAULT_CONFIG, {
        credentials: { ...DEFAULT_CONFIG.credentials, password: "pancake-secret-1" },
        reconnect: { enabled: false, delayMs: 1000, maxAttempts: 0 },
        antiIdle: { enabled: false, intervalMs: 60000 },
        resourcePack: { ...DEFAULT_CONFIG.resourcePack, policy: "accept" },
      });
      const logger = new BotLogger({ capacity: 400, minLevel: "debug" });
      const bot = new Bot({
        config,
        logger,
        createTransport: (cfg) =>
          new SimulatedTransport({
            host: cfg.host,
            port: cfg.port,
            scenario: "gui-login",
            logger,
          }),
      });

      try {
        // status ping -> handshake -> login -> configuration -> play
        await bot.connect();
        const snap = bot.snapshot();
        expect(snap.connection?.phase).toBe("play");
        expect(snap.activity).toBe("idle");
        // version detection ran through a real status exchange
        expect(snap.serverStatus?.protocol).toBe(774);

        // resource pack handled during configuration (policy=accept -> loaded)
        expect(snap.resourcePack.phase).toBe("loaded");

        // GUI authentication: window opened, clicked, success chat observed
        const authed = await waitFor(
          () => bot.snapshot().auth.status === "succeeded",
          15000,
        );
        expect(authed).toBe(true);
        expect(bot.snapshot().auth.attempts).toBeGreaterThanOrEqual(1);

        // world data arrives after play starts
        const worldLoaded = await waitFor(
          () => {
            const s = bot.snapshot();
            return (
              s.world.chunksLoaded > 0 &&
              s.world.players.length >= 3 &&
              s.world.recentChat.length > 0
            );
          },
          10000,
        );
        expect(worldLoaded).toBe(true);

        const final = bot.snapshot();
        expect(final.player.health).toBe(20);
        expect(final.player.food).toBe(20);
        expect(final.player.dimension).toBe("minecraft:overworld");
        expect(final.world.entityCount).toBeGreaterThanOrEqual(3);
        expect(final.connection?.encrypted).toBe(false);
      } finally {
        bot.disconnect("e2e test complete");
      }
    },
    60000,
  );

  test(
    "chat-login scenario authenticates via the /login command",
    async () => {
      const config = mergeConfig(DEFAULT_CONFIG, {
        credentials: { ...DEFAULT_CONFIG.credentials, password: "pancake-secret-1" },
        reconnect: { enabled: false, delayMs: 1000, maxAttempts: 0 },
        antiIdle: { enabled: false, intervalMs: 60000 },
      });
      const logger = new BotLogger({ capacity: 200, minLevel: "info" });
      const bot = new Bot({
        config,
        logger,
        createTransport: (cfg) =>
          new SimulatedTransport({
            host: cfg.host,
            port: cfg.port,
            scenario: "chat-login",
            logger,
          }),
      });

      try {
        await bot.connect();
        expect(bot.snapshot().connection?.phase).toBe("play");
        const authed = await waitFor(
          () => bot.snapshot().auth.status === "succeeded",
          20000,
        );
        expect(authed).toBe(true);
        // the password must never appear anywhere in the log stream
        const logText = JSON.stringify(logger.snapshot());
        expect(logText).not.toContain("pancake-secret-1");
      } finally {
        bot.disconnect("e2e chat test complete");
      }
    },
    60000,
  );
});
