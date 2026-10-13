import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolServer } from "./goose";
import { fakeSpawn, flush } from "./goose-testing";
import { AgentSessions, IDLE_MS, type Launch } from "./sessions";

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

const setup = (initial: Partial<Launch> = {}, hold = false) => {
  const fake = fakeSpawn({ home: "/home/test", hold });
  let settings: Launch = {
    workspace: "~/.buzz",
    env: {},
    systemPrompt: "prompt",
    ...initial,
  };
  const sessions = new AgentSessions({
    spawn: fake.spawn,
    tools,
    launch: async () => settings,
    processFingerprint: () =>
      JSON.stringify([settings.workspace, settings.env]),
    fingerprint: () =>
      JSON.stringify([settings.workspace, settings.systemPrompt]),
  });
  return {
    fake,
    sessions,
    change: (next: Partial<Launch>, reconfigure = true) => {
      settings = { ...settings, ...next };
      if (reconfigure) sessions.reconfigure();
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentSessions", () => {
  it("serves each conversation from its own session in one process", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await sessions.deliver("b", "two", 2);
    await sessions.deliver("a", "three", 3);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.opened).toHaveLength(2);
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "two"],
      ["session-1", "three"],
    ]);
    expect(sessions.seen("a")).toBe(3);
  });

  it("opens sessions in the workspace as an absolute path", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    expect(fake.geese[0]?.options.cwd).toBe("/home/test/.buzz");
    expect(fake.geese[0]?.opened[0]?.cwd).toBe("/home/test/.buzz");
  });

  it("opens one session for messages that arrive together", async () => {
    const { fake, sessions } = setup();
    await Promise.all([
      sessions.deliver("a", "one", 1),
      sessions.deliver("a", "two", 2),
    ]);
    expect(fake.geese[0]?.opened).toHaveLength(1);
  });

  it("closes idle sessions when their settings change", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" });
    await flush(30);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(sessions.seen("a")).toBe(0);
  });

  it("shows a reopened conversation everything again", async () => {
    const { fake, sessions, change } = setup();
    const fresh = vi.fn(async () => "everything so far");
    await sessions.deliver("a", "one", 1, { fresh });
    expect(fresh).not.toHaveBeenCalled();
    change({ systemPrompt: "newer" }, false);
    await sessions.deliver("a", "two", 2, { fresh });
    const [goose] = fake.geese;
    expect(fake.geese).toHaveLength(1);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.prompts.get("session-2")).toBe("newer");
    expect(goose?.turns.at(-1)?.text).toBe("everything so far");
  });

  it("restarts the process for a new model once nothing runs in it", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    const [first] = fake.geese;
    if (first) first.hold = true;
    const working = sessions.deliver("b", "two", 2);
    await flush(30);
    change({ env: { GOOSE_MODEL: "other" } });
    await flush(30);
    // `a` was idle, so it closed; `b` keeps the old process while it works.
    expect(first?.closed).toEqual(["session-1"]);
    expect(first?.killed).toBe(false);
    await sessions.deliver("c", "three", 3);
    expect(fake.geese).toHaveLength(2);
    expect(fake.geese[1]?.options.env).toMatchObject({ GOOSE_MODEL: "other" });
    first?.turns.at(-1)?.finish();
    await working;
    await flush(30);
    expect(first?.killed).toBe(true);
  });

  it("closes a quiet conversation's session", async () => {
    vi.useFakeTimers();
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(sessions.snapshot()).toEqual([]);
    expect(sessions.seen("a")).toBe(0);
  });

  it("starts goose again after it exits", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    fake.geese[0]?.exit(1, "crashed");
    await flush(30);
    await expect(sessions.deliver("a", "two", 2)).resolves.toEqual({
      ok: true,
    });
    expect(fake.geese).toHaveLength(2);
  });

  it("reports why goose could not start", async () => {
    const fake = fakeSpawn({ acp: false });
    const sessions = new AgentSessions({
      spawn: fake.spawn,
      tools,
      launch: async () => ({ workspace: "/w", env: {}, systemPrompt: "" }),
      processFingerprint: () => "",
      fingerprint: () => "",
    });
    await expect(sessions.deliver("a", "one", 1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/MCP-over-ACP/),
    });
  });

  it("runs a one-off turn in a session it then closes", async () => {
    const { fake, sessions } = setup();
    await expect(sessions.runOnce("watch/x", () => "look")).resolves.toEqual({
      ok: true,
    });
    const [goose] = fake.geese;
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["look"]);
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.killed).toBe(false);
    expect(sessions.snapshot()).toEqual([]);
  });

  it("stops a one-off turn at its deadline", async () => {
    vi.useFakeTimers();
    const { fake, sessions } = setup({}, true);
    const running = sessions.runOnce("timer/x", () => "wait", {
      deadline: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const [goose] = fake.geese;
    await expect(running).resolves.toMatchObject({ ok: false });
    expect(goose?.cancelled).toEqual(["session-1"]);
  });

  it("stops its processes when disposed", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    sessions.dispose();
    await flush(30);
    expect(fake.geese[0]?.killed).toBe(true);
    await expect(sessions.deliver("a", "two", 2)).resolves.toMatchObject({
      ok: false,
    });
  });
});
