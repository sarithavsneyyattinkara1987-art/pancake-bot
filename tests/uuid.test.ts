import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { md5, offlineUuid } from "../src/bot/protocol/uuid";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("md5", () => {
  test("matches node:crypto for empty input", () => {
    expect(hex(md5(new Uint8Array(0)))).toBe(createHash("md5").update("").digest("hex"));
  });

  test("matches node:crypto across many lengths (incl. padding boundaries)", () => {
    for (const len of [1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = (i * 31 + 7) & 0xff;
      const expected = createHash("md5").update(Buffer.from(data)).digest("hex");
      expect(hex(md5(data))).toBe(expected);
    }
  });
});

describe("offlineUuid", () => {
  /** Independent reference: version-3 UUID of "OfflinePlayer:<name>". */
  function reference(name: string): string {
    const digest = Buffer.from(createHash("md5").update(`OfflinePlayer:${name}`).digest());
    digest[6] = (digest[6] & 0x0f) | 0x30; // version 3
    digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hexStr = digest.toString("hex");
    return `${hexStr.slice(0, 8)}-${hexStr.slice(8, 12)}-${hexStr.slice(12, 16)}-${hexStr.slice(16, 20)}-${hexStr.slice(20)}`;
  }

  test("matches the canonical offline UUID derivation", () => {
    for (const name of ["Notch", "pancakeBot", "Steve_2011", "üñïçødé"]) {
      expect(offlineUuid(name)).toBe(reference(name));
    }
  });

  test("shape: version 3, RFC variant, deterministic", () => {
    const uuid = offlineUuid("pancakeBot");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(offlineUuid("pancakeBot")).toBe(uuid);
    expect(offlineUuid("pancakebot")).not.toBe(uuid);
  });
});
