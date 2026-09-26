import { describe, expect, test } from "bun:test";
import { REGISTRY_774 } from "../src/bot/protocol/registry";
import { MCReader, MCWriter } from "../src/bot/protocol/primitives";
import { readSlot } from "../src/bot/protocol/slots";

describe("protocol 774 packet tables", () => {
  test("identity metadata", () => {
    expect(REGISTRY_774.protocolVersion).toBe(774);
    expect(REGISTRY_774.versionName).toContain("1.21.11");
  });

  test("handshake/status packet ids", () => {
    expect(REGISTRY_774.nameFor("status", "toServer", 0x00)).toBe("ping_start");
    expect(REGISTRY_774.nameFor("status", "toClient", 0x00)).toBe("server_info");
    expect(REGISTRY_774.idFor("handshake", "toServer", "set_protocol")).toBe(0x00);
  });

  test("login packet ids", () => {
    expect(REGISTRY_774.nameFor("login", "toServer", 0x00)).toBe("login_start");
    expect(REGISTRY_774.nameFor("login", "toClient", 0x02)).toBe("success");
    expect(REGISTRY_774.nameFor("login", "toClient", 0x03)).toBe("compress");
    expect(REGISTRY_774.idFor("login", "toServer", "login_acknowledged")).toBe(0x03);
  });

  test("configuration packet ids (resource pack + finish)", () => {
    expect(REGISTRY_774.nameFor("configuration", "toClient", 0x09)).toBe("add_resource_pack");
    expect(REGISTRY_774.nameFor("configuration", "toClient", 0x03)).toBe("finish_configuration");
    expect(REGISTRY_774.idFor("configuration", "toServer", "resource_pack_receive")).toBe(0x06);
  });

  test("play packet ids used by the bot", () => {
    expect(REGISTRY_774.nameFor("play", "toClient", 0x01)).toBe("spawn_entity");
    expect(REGISTRY_774.nameFor("play", "toClient", 0x30)).toBe("login");
    expect(REGISTRY_774.nameFor("play", "toClient", 0x66)).toBe("update_health");
    expect(REGISTRY_774.nameFor("play", "toClient", 0x77)).toBe("system_chat");
    expect(REGISTRY_774.idFor("play", "toServer", "chat_command")).toBe(0x06);
    expect(REGISTRY_774.idFor("play", "toServer", "position")).toBe(0x1d);
    expect(REGISTRY_774.idFor("play", "toServer", "keep_alive")).toBe(0x1b);
  });

  test("every name resolves back to its own id (roundtrip)", () => {
    for (const phase of ["status", "login", "configuration", "play"] as const) {
      for (const direction of ["toClient", "toServer"] as const) {
        const table = REGISTRY_774[phase][direction];
        table.forEach((name, id) => {
          if (!name) return;
          expect(REGISTRY_774.idFor(phase, direction, name)).toBe(id);
          expect(REGISTRY_774.nameFor(phase, direction, id!)).toBe(name);
        });
      }
    }
  });

  test("unknown ids resolve to null", () => {
    expect(REGISTRY_774.nameFor("play", "toClient", 0x7fffffff)).toBeNull();
    expect(REGISTRY_774.idFor("play", "toServer", "no_such_packet")).toBeNull();
  });
});

describe("slot decoding", () => {
  test("empty slot decodes to null", () => {
    const w = new MCWriter();
    w.varint(0);
    expect(readSlot(new MCReader(w.done()))).toBeNull();
  });

  test("simple stack decodes count and item id", () => {
    const w = new MCWriter();
    w.varint(1); // count
    w.varint(42); // itemId
    w.varint(0); // added components
    w.varint(0); // removed components
    const slot = readSlot(new MCReader(w.done()));
    expect(slot).not.toBeNull();
    expect(slot!.count).toBe(1);
    expect(slot!.itemId).toBe(42);
    expect(slot!.addedComponentCount).toBe(0);
    expect(slot!.removedComponentCount).toBe(0);
  });

  test("truncated slot throws a packet error", () => {
    const w = new MCWriter();
    w.varint(1); // count but nothing else
    expect(() => readSlot(new MCReader(w.done()))).toThrow();
  });
});
