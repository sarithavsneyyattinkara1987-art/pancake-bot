import { describe, expect, test } from "bun:test";
import { runCommand, type CommandApi } from "../src/bot/core/commands";
import type { Bot } from "../src/bot/core/bot";

function makeApi(sent: string[] = []): CommandApi {
  const bot = {
    sendCommandText(message: string) {
      sent.push(message);
    },
    stop: () => "Stopped.",
    goto: () => "Path computed (12 steps)",
    follow: () => "Following Alice",
  } as unknown as Bot;
  return {
    bot,
    connect: () => Promise.resolve(),
    disconnect: () => {},
  };
}

describe("console commands", () => {
  test("empty input is a no-op", () => {
    const result = runCommand("   ", makeApi());
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([]);
  });

  test("help lists the documented verbs", () => {
    const result = runCommand("help", makeApi());
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toMatch(/connect/);
    expect(result.lines.join("\n")).toMatch(/resourcepack/);
    expect(result.lines.join("\n")).toMatch(/goto/);
  });

  test("say forwards chat and keeps leading slashes for commands", () => {
    const sent: string[] = [];
    const api = makeApi(sent);
    expect(runCommand("say hello world", api)).toEqual({ lines: ["> hello world"], ok: true });
    expect(runCommand("say /spawn", api)).toEqual({ lines: ["> /spawn"], ok: true });
    expect(sent).toEqual(["hello world", "/spawn"]);
  });

  test("say without a message fails", () => {
    const result = runCommand("say", makeApi());
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/Usage/);
  });

  test("goto validates numeric coordinates", () => {
    expect(runCommand("goto 10 64 -3", makeApi()).ok).toBe(true);
    expect(runCommand("goto banana 64 0", makeApi()).ok).toBe(false);
    expect(runCommand("goto 1 2", makeApi()).ok).toBe(false);
  });

  test("stop and disconnect return confirmations", () => {
    expect(runCommand("stop", makeApi()).lines).toEqual(["Stopped."]);
    expect(runCommand("disconnect", makeApi()).lines).toEqual(["Disconnected."]);
  });

  test("follow accepts a player or off", () => {
    const result = runCommand("follow Alice", makeApi());
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(/Following Alice/);
    expect(runCommand("follow off", makeApi()).lines).toEqual(["Stopped."]);
  });

  test("unknown commands suggest the say escape hatch", () => {
    const result = runCommand("frobnicate now", makeApi());
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/Unknown command/);
    expect(result.lines[1]).toMatch(/say frobnicate now/);
  });

  test("leading slash is treated as a console verb too", () => {
    const result = runCommand("/help", makeApi());
    expect(result.ok).toBe(true);
    expect(result.lines.length).toBeGreaterThan(5);
  });
});
