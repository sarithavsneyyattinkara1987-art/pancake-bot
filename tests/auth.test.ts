import { describe, expect, test } from "bun:test";
import { AuthFlow, detectIntent, isFailureText, isSuccessText } from "../src/bot/core/auth";
import type { AuthFlowOptions, WindowSummary } from "../src/bot/core/auth";

function options(patch: Partial<AuthFlowOptions> = {}): AuthFlowOptions {
  return {
    credentials: {
      username: "pancakeBot",
      password: "hunter2supersecret",
      password2: "hunter2supersecret",
      loginCommand: "/login {password}",
      registerCommand: "/register {password} {password2}",
    },
    gui: { enabled: true, submitDelayMs: 0, slots: [], timeoutMs: 30000 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...patch,
  };
}

function window(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    windowId: 3,
    stateId: 1,
    title: "Login",
    items: { 4: "Login" },
    ...overrides,
  };
}

describe("prompt detection helpers", () => {
  test("detectIntent classifies login and register wording", () => {
    expect(detectIntent("Please log in to continue")).toBe("login");
    expect(detectIntent("You must /login first")).toBe("login");
    expect(detectIntent("Register an account with /register")).toBe("register");
    expect(detectIntent("Welcome to the server!")).toBeNull();
    expect(detectIntent("")).toBeNull();
  });

  test("success/failure classifiers", () => {
    expect(isSuccessText("Successfully logged in!")).toBe(true);
    expect(isSuccessText("Login successful")).toBe(true);
    expect(isFailureText("Invalid password")).toBe(true);
    expect(isFailureText("Login failed: too many attempts")).toBe(true);
    expect(isFailureText("You are now logged in")).toBe(false);
  });
});

describe("chat-driven authentication", () => {
  test("login prompt produces a filled login command", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeText("chat", "Please log in to continue!");
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ type: "command", command: "/login hunter2supersecret" });
    expect(flow.state.status).toBe("submitted");
    expect(flow.state.attempts).toBe(1);
  });

  test("register prompt uses the register template with both passwords", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeText("chat", "You need to register first");
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      type: "command",
      command: "/register hunter2supersecret hunter2supersecret",
    });
  });

  test("success text transitions to succeeded and ignores later prompts", () => {
    const flow = new AuthFlow(options());
    flow.observeText("chat", "Successfully logged in!");
    expect(flow.state.status).toBe("succeeded");
    expect(flow.state.successText).toBe("Successfully logged in!");
    const again = flow.observeText("chat", "Please log in to continue!");
    expect(again.length).toBe(0);
    expect(flow.state.status).toBe("succeeded");
  });

  test("missing-account failure retries with register", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeText("chat", "Login failed: you are not registered");
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ type: "command" });
    expect((actions[0] as { command: string }).command).toMatch(/^\/register /);
  });

  test("duplicate prompts inside the dedup window produce no second submission", () => {
    let t = 1_000_000;
    const flow = new AuthFlow(options({ now: () => t }));
    const first = flow.observeText("chat", "Please log in to continue!");
    expect(first.length).toBe(1);
    t += 500;
    const second = flow.observeText("chat", "Please log in to continue!");
    expect(second.length).toBe(0);
    expect(flow.state.attempts).toBe(1);
  });

  test("no password configured logs an error and submits nothing", () => {
    const errors: string[] = [];
    const flow = new AuthFlow(
      options({
        credentials: {
          username: "pancakeBot",
          loginCommand: "/login {password}",
          registerCommand: "/register {password}",
        },
        logger: {
          debug() {},
          info() {},
          warn() {},
          error: (_scope: string, message: string) => {
            errors.push(message);
          },
        },
      }),
    );
    const actions = flow.observeText("chat", "Please log in to continue!");
    expect(actions.length).toBe(0);
    expect(errors.join(" ")).toMatch(/no password configured/i);
  });
});

describe("GUI-driven authentication", () => {
  test("login window yields a click on the login item slot", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeWindow(window());
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ type: "click", windowId: 3, slot: 4 });
    expect(flow.state.status).toBe("submitting");
    expect(flow.state.guiWindow?.windowId).toBe(3);
  });

  test("configured explicit slot wins over auto-detection", () => {
    const flow = new AuthFlow(
      options({ gui: { enabled: true, submitDelayMs: 0, slots: [11], timeoutMs: 30000 } }),
    );
    const actions = flow.observeWindow(window());
    expect(actions[0]).toMatchObject({ type: "click", slot: 11 });
  });

  test("GUI disabled falls back to the chat command", () => {
    const flow = new AuthFlow(
      options({ gui: { enabled: false, submitDelayMs: 0, slots: [], timeoutMs: 30000 } }),
    );
    const actions = flow.observeWindow(window());
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ type: "command", command: "/login hunter2supersecret" });
  });

  test("unrelated windows are ignored", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeWindow(
      window({ title: "Chest", items: { 0: "Diamond", 1: "Dirt" } }),
    );
    expect(actions.length).toBe(0);
    expect(flow.state.status).toBe("idle");
  });

  test("window without contents yet is recorded but not acted on", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeWindow(window({ items: {} }));
    expect(actions.length).toBe(0);
    expect(flow.state.guiWindow?.windowId).toBe(3);
  });

  test("closing the window after a click marks the submission as sent", () => {
    const flow = new AuthFlow(options());
    flow.observeWindow(window());
    expect(flow.state.status).toBe("submitting");
    flow.observeWindowClosed(3);
    expect(flow.state.status).toBe("submitted");
  });
});

describe("sign editor and timeouts", () => {
  test("sign editor receives the password on line 1", () => {
    const flow = new AuthFlow(options());
    const actions = flow.observeSignEditor();
    expect(actions).toEqual([
      { type: "sign", lines: ["hunter2supersecret", "", "", ""], reason: expect.any(String) },
    ]);
    expect(flow.state.status).toBe("submitted");
  });

  test("tick retries once after the GUI auth timeout", () => {
    let t = 1_000_000;
    const flow = new AuthFlow(options({ now: () => t }));
    flow.observeText("chat", "Please log in to continue!");
    expect(flow.state.attempts).toBe(1);
    t += 31_000;
    const actions = flow.tick();
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ type: "command" });
    expect(flow.state.attempts).toBe(2);
    t += 31_000;
    flow.tick();
    expect(flow.state.status).toBe("timeout");
  });
});

describe("secrets never leak", () => {
  test("describe() and history never contain the password", () => {
    const flow = new AuthFlow(options());
    flow.observeText("chat", "Please log in to continue!");
    flow.observeWindow(window());
    const snapshot = JSON.stringify({ describe: flow.describe(), state: flow.state });
    expect(snapshot).not.toContain("hunter2supersecret");
    expect(flow.describe().hasPassword).toBe(true);
  });
});
