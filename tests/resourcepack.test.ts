import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ResourcePackHandler,
  ResourcePackStatus,
  type ResourcePackConfigLike,
  type ResourcePackRequest,
} from "../src/bot/core/resourcePack";
import type { BotLogger } from "../src/bot/core/logger";

function silentLogger(): Pick<BotLogger, "debug" | "info" | "warn" | "error"> {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function config(policy: ResourcePackConfigLike["policy"]): ResourcePackConfigLike {
  return { policy, timeoutMs: 5000, maxBytes: 1024 * 1024, cache: true };
}

function request(overrides: Partial<ResourcePackRequest> = {}): ResourcePackRequest {
  return {
    id: "2c6f7f8a-1111-4222-8333-444455556666",
    url: "https://cdn.example.com/pack.zip",
    hash: "",
    required: false,
    source: "configuration",
    receivedAt: Date.now(),
    ...overrides,
  };
}

function handler(policy: ResourcePackConfigLike["policy"], fetchImpl?: typeof fetch) {
  return new ResourcePackHandler(config(policy), {
    logger: silentLogger(),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

const statuses = (outcome: { responses: { status: number }[] }) =>
  outcome.responses.map((r) => r.status);

describe("resource-pack policies", () => {
  test("decline policy declines an optional pack", async () => {
    const h = handler("decline");
    const outcome = await h.handle(request());
    expect(outcome.ok).toBe(true);
    expect(outcome.fatal).toBe(false);
    expect(statuses(outcome)).toEqual([ResourcePackStatus.DECLINED]);
    expect(h.state.phase).toBe("declined");
  });

  test("decline policy on a required pack is fatal with a diagnostic", async () => {
    const h = handler("decline");
    const outcome = await h.handle(request({ required: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toBe(true);
    expect(outcome.diagnostic).toMatch(/requires resource pack/i);
    expect(statuses(outcome)).toEqual([ResourcePackStatus.DECLINED]);
  });

  test("required-only declines optional packs and accepts required ones", async () => {
    const h = handler("required-only");
    const optional = await h.handle(request());
    expect(optional.fatal).toBe(false);
    expect(statuses(optional)).toEqual([ResourcePackStatus.DECLINED]);

    const required = await h.handle(request({ required: true }));
    expect(required.ok).toBe(true);
    expect(required.fatal).toBe(false);
    expect(statuses(required)).toEqual([
      ResourcePackStatus.ACCEPTED,
      ResourcePackStatus.SUCCESSFULLY_LOADED,
    ]);
    expect(h.state.phase).toBe("loaded");
  });

  test("accept policy confirms load without downloading bytes", async () => {
    const h = handler("accept");
    const outcome = await h.handle(request());
    expect(outcome.ok).toBe(true);
    expect(statuses(outcome)).toEqual([
      ResourcePackStatus.ACCEPTED,
      ResourcePackStatus.SUCCESSFULLY_LOADED,
    ]);
    expect(h.state.downloadedBytes).toBe(0);
  });
});

describe("download-and-accept", () => {
  const pack = new Uint8Array(2048);
  for (let i = 0; i < pack.length; i++) pack[i] = (i * 13) & 0xff;
  const sha1 = createHash("sha1").update(Buffer.from(pack)).digest("hex");

  function fetchReturning(bytes: Uint8Array): typeof fetch {
    return (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-length": String(bytes.byteLength) }),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }) as unknown as Response) as typeof fetch;
  }

  test("downloads, verifies the hash and confirms the pack", async () => {
    const h = handler("download-and-accept", fetchReturning(pack));
    const outcome = await h.handle(request({ hash: sha1 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.fatal).toBe(false);
    expect(statuses(outcome)).toEqual([
      ResourcePackStatus.ACCEPTED,
      ResourcePackStatus.DOWNLOADED,
      ResourcePackStatus.SUCCESSFULLY_LOADED,
    ]);
    expect(h.state.downloadedBytes).toBe(pack.byteLength);
    expect(h.state.verified).toBe(true);
    expect(h.state.phase).toBe("loaded");
  });

  test("hash mismatch fails and is fatal for required packs", async () => {
    const h = handler("download-and-accept", fetchReturning(pack));
    const outcome = await h.handle(
      request({ required: true, hash: "0".repeat(40) }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toBe(true);
    expect(outcome.diagnostic).toMatch(/failed to download/i);
    expect(statuses(outcome)).toContain(ResourcePackStatus.FAILED_DOWNLOAD);
    expect(h.state.lastError).toMatch(/hash mismatch/i);
  });

  test("second request is served from the session cache", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-length": String(pack.byteLength) }),
        arrayBuffer: async () =>
          pack.buffer.slice(pack.byteOffset, pack.byteOffset + pack.byteLength),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const h = handler("download-and-accept", counting);
    await h.handle(request({ hash: sha1 }));
    const second = await h.handle(request({ hash: sha1 }));
    expect(calls).toBe(1);
    expect(second.ok).toBe(true);
    expect(h.state.cached).toBe(true);
  });

  test("non-http URLs are rejected as INVALID_URL", async () => {
    const h = handler("download-and-accept", fetchReturning(pack));
    const outcome = await h.handle(request({ url: "file:///etc/passwd", required: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toBe(true);
    expect(statuses(outcome)).toContain(ResourcePackStatus.INVALID_URL);
  });

  test("HTTP errors fail the download", async () => {
    const failing = (async () =>
      ({ ok: false, status: 404, statusText: "Not Found", headers: new Headers() }) as unknown as Response) as typeof fetch;
    const h = handler("download-and-accept", failing);
    const outcome = await h.handle(request({ hash: sha1, required: true }));
    expect(outcome.ok).toBe(false);
    expect(h.state.lastError).toMatch(/HTTP 404/);
  });
});
