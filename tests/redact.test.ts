import { beforeEach, describe, expect, test } from "bun:test";
import {
  REDACTED,
  containsSecret,
  forgetSecrets,
  redact,
  redactData,
  registerSecret,
  secretCount,
} from "../src/bot/core/redact";

describe("secret redaction", () => {
  beforeEach(() => {
    forgetSecrets();
  });

  test("registered secrets never survive redact()", () => {
    registerSecret("hunter2supersecret");
    expect(secretCount()).toBe(1);
    const text = "player typed /login hunter2supersecret and password=hunter2supersecret";
    const cleaned = redact(text);
    expect(cleaned).not.toContain("hunter2supersecret");
    expect(cleaned).toContain(REDACTED);
    expect(containsSecret(text)).toBe(true);
    expect(containsSecret(cleaned)).toBe(false);
  });

  test("redacts /login and /register command shapes even unregistered", () => {
    forgetSecrets();
    const cleaned = redact("/register secretcookie secondcookie please");
    expect(cleaned).not.toContain("secretcookie");
    expect(cleaned).not.toContain("secondcookie");
    expect(cleaned).toContain("/register");
  });

  test("redacts key=value / key: value shapes", () => {
    forgetSecrets();
    expect(redact("token: abc123def")).not.toContain("abc123def");
    expect(redact("password=hunter2")).not.toContain("hunter2");
    expect(redact("accessToken=xyz")).not.toContain("xyz");
  });

  test("very short secrets are not registered (would redact normal text)", () => {
    forgetSecrets();
    registerSecret("ab");
    expect(secretCount()).toBe(0);
  });

  test("redactData scrubs secret-shaped keys in structured data", () => {
    registerSecret("hunter2supersecret");
    const data = redactData({
      password: "hunter2supersecret",
      nested: { accessToken: "tok-123", note: "password=hunter2supersecret" },
      list: ["fine", "hunter2supersecret"],
    });
    const json = JSON.stringify(data);
    expect(json).not.toContain("hunter2supersecret");
    expect(json).not.toContain("tok-123");
    expect(data.nested.note).toContain(REDACTED);
    expect(data.list[0]).toBe("fine");
  });
});
