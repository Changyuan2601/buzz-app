import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, type ServeMcp, type ToolServer } from "./goose";
import { fakeSpawn, flush } from "./goose-testing";
import { AgentSessions, IDLE_MS, type Launch, ServerPool } from "./sessions";

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

const setup = (
  initial: Partial<Launch> = {},
  hold = false,
  {
    pool = new ServerPool(),
    serve,
    silent,
    onChange,
  }: Readonly<{
    pool?: ServerPool;
    onChange?: () => void;
    /** Wraps the fake's `serve`. */
    serve?: (serve: ServeMcp) => ServeMcp;
    silent?: readonly string[];
  }> = {},
) => {
  const fake = fakeSpawn({
    home: "/home/test",
    hold,
    ...(silent && { silent }),
  });
  let settings: Launch = {
    workspace: "~/.buzz",
    env: {},
    systemPrompt: "prompt",
    ...initial,
  };
  const sessions = new AgentSessions({
    spawn: fake.spawn,
    tools,
    serve: serve ? serve(fake.serve) : fake.serve,
    pool,
    ...(onChange && { onChange }),
    launch: async () => settings,
    processFingerprint: () =>
      JSON.stringify([settings.workspace, settings.env]),
    fingerprint: () =>
      JSON.stringify([settings.workspace, settings.systemPrompt]),
  });
  return {
    fake,
    sessions,
    pool,
    change: (next: Partial<Launch>, reconfigure = true) => {
      settings = { ...settings, ...next };
      if (reconfigure) sessions.reconfigure();
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

/** A host that, like the app's, counts a server until its close finishes and
 * refuses one past `cap`. Closes finish once `release` is called. */
const host = (cap: number) => {
  let running = 0;
  let release!: () => void;
  const stopping = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    serve:
      (serve: ServeMcp): ServeMcp =>
      async (handler) => {
        if (running >= cap) throw "Too many MCP servers are running";
        running++;
        const server = await serve(handler);
        const closed = server.closed
          .then(() => stopping)
          .then(() => {
            running--;
          });
        return { ...server, closed };
      },
  };
};

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

  it("keeps a process whose settings change while a session opens in it", async () => {
    let gate: Promise<void> | undefined;
    const { fake, sessions, change } = setup({}, false, {
      serve: (serve) => async (handler) => {
        await gate;
        return serve(handler);
      },
    });
    await sessions.deliver("a", "one", 1);
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = sessions.deliver("b", "two", 2);
    await flush(30);
    change({ env: { GOOSE_MODEL: "other" } });
    await flush(30);
    const [first] = fake.geese;
    expect(first?.killed).toBe(false);
    release();
    await expect(opening).resolves.toEqual({ ok: true });
    expect(first?.turns.map((turn) => turn.text)).toEqual(["one", "two"]);
    // Nothing runs in it any more, so it stops.
    await flush(30);
    expect(first?.killed).toBe(true);
  });

  it("stops an old process once idle after its settings come back", async () => {
    vi.useFakeTimers();
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    const [a1] = fake.geese;
    if (a1) a1.hold = true;
    const working = sessions.deliver("a", "two", 2);
    await flush(30);
    change({ env: { GOOSE_MODEL: "other" } });
    await sessions.deliver("b", "three", 3);
    change({ env: {} });
    await sessions.deliver("c", "four", 4);
    const [, b, a2] = fake.geese;
    expect(b?.killed).toBe(true);
    a1?.turns.at(-1)?.finish();
    await working;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(a1?.killed).toBe(true);
    expect(a2?.killed).toBe(false);
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
    const fake = fakeSpawn({ http: false });
    const sessions = new AgentSessions({
      spawn: fake.spawn,
      tools,
      serve: fake.serve,
      pool: new ServerPool(),
      launch: async () => ({ workspace: "/w", env: {}, systemPrompt: "" }),
      processFingerprint: () => "",
      fingerprint: () => "",
    });
    await expect(sessions.deliver("a", "one", 1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/HTTP MCP/),
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

  it("stops a one-off turn when its signal aborts", async () => {
    const { fake, sessions } = setup({}, true);
    const abort = new AbortController();
    const running = sessions.runOnce("timer/x", () => "wait", {
      signal: abort.signal,
    });
    await flush(30);
    abort.abort(new Error("The turn ran past its deadline"));
    await expect(running).resolves.toEqual({
      ok: false,
      error: "The turn ran past its deadline",
    });
    expect(fake.geese[0]?.cancelled).toEqual(["session-1"]);
  });

  it("gives up a one-off turn whose session is still opening, and closes it once open", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, sessions, pool } = setup({}, false, {
      serve: (serve) => async (handler) => {
        await gate;
        return serve(handler);
      },
    });
    const abort = new AbortController();
    const prompt = vi.fn(() => "look");
    const running = sessions.runOnce("watch/x", prompt, {
      signal: abort.signal,
    });
    await flush(30);
    abort.abort(new Error("The agent was removed"));
    await expect(running).resolves.toEqual({
      ok: false,
      error: "The agent was removed",
    });
    release();
    await flush(30);
    expect(prompt).not.toHaveBeenCalled();
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.servers.map((server) => server.closed)).toEqual([true]);
    expect(pool.size).toBe(0);
  });

  it("opens one replacement session for messages that arrive while it reopens", async () => {
    vi.useFakeTimers();
    const { fake, sessions, pool, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" }, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Rebuilding the conversation for the new session is held open.
    const fresh = vi.fn(async () => {
      await gate;
      return "everything so far";
    });
    const first = sessions.deliver("a", "two", 2, { fresh });
    const second = sessions.deliver("a", "three", 3, { fresh });
    await flush(30);
    expect(fresh).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    const [goose] = fake.geese;
    expect(goose?.opened).toHaveLength(2);
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "everything so far"],
      ["session-2", "three"],
    ]);
    expect(sessions.snapshot()).toEqual([
      { key: "a", busy: false, sessionId: "session-2" },
    ]);
    // Nothing is left open once the conversation goes quiet.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(goose?.closed).toEqual(["session-1", "session-2"]);
    expect(fake.servers.map((server) => server.closed)).toEqual([true, true]);
    expect(pool.size).toBe(0);
  });

  it("stops waiting for a session that opens too late, and keeps it for the next message", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" }, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = async () => {
      await gate;
      return "everything so far";
    };
    const abort = new AbortController();
    const late = sessions.deliver("a", "two", 2, {
      fresh,
      signal: abort.signal,
    });
    await flush(30);
    abort.abort();
    await expect(late).resolves.toEqual({
      ok: false,
      error: "goose did not start in time",
    });
    release();
    await flush(30);
    await sessions.deliver("a", "three", 3);
    const [goose] = fake.geese;
    expect(goose?.opened).toHaveLength(2);
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "three"],
    ]);
  });

  it("sends nothing for a message that gives up waiting on another's session", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ systemPrompt: "newer" }, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = async () => {
      await gate;
      return "everything so far";
    };
    const opening = sessions.deliver("a", "two", 2, { fresh });
    await flush(30);
    const abort = new AbortController();
    const expired = sessions.deliver("a", "three", 3, {
      signal: abort.signal,
    });
    await flush(30);
    abort.abort();
    await expect(expired).resolves.toEqual({
      ok: false,
      error: "goose did not start in time",
    });
    release();
    await expect(opening).resolves.toEqual({ ok: true });
    await flush(30);
    const [goose] = fake.geese;
    expect(goose?.turns.map((turn) => [turn.sessionId, turn.text])).toEqual([
      ["session-1", "one"],
      ["session-2", "everything so far"],
    ]);
    expect(goose?.turns[1]?.steered).toEqual([]);
  });

  it("stops a goose that hangs opening a session", async () => {
    vi.useFakeTimers();
    const { fake, sessions, pool } = setup({}, false, {
      silent: ["session/new"],
    });
    const opening = sessions.deliver("a", "one", 1);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await expect(opening).resolves.toEqual({
      ok: false,
      error: "goose could not start: goose did not answer session/new in 60s",
    });
    expect(fake.geese[0]?.killed).toBe(true);
    expect(fake.servers.map((server) => server.closed)).toEqual([true]);
    expect(pool.size).toBe(0);
  });

  it("closes the least recently used idle session of any agent to make room", async () => {
    const pool = new ServerPool(2);
    const one = setup({}, false, { pool });
    const two = setup({}, true, { pool });
    await one.sessions.deliver("a", "one", 1);
    await one.sessions.deliver("b", "two", 2);
    await one.sessions.deliver("a", "three", 3);
    // `b` is now the least recently used.
    const working = two.sessions.deliver("c", "four", 4);
    await flush(30);
    expect(one.fake.geese[0]?.closed).toEqual(["session-2"]);
    expect(one.sessions.snapshot().map((live) => live.key)).toEqual(["a"]);
    // `c` is working, so `a` closes for the next.
    await one.sessions.deliver("d", "five", 5);
    expect(one.fake.geese[0]?.closed).toEqual(["session-2", "session-1"]);
    expect(two.fake.geese[0]?.closed).toEqual([]);
    expect(pool.size).toBe(2);
    two.fake.geese[0]?.turns[0]?.finish();
    await working;
  });

  it("never closes a new session to make room before its first message is sent", async () => {
    const pool = new ServerPool(1);
    let evicted: unknown;
    const { fake, sessions } = setup({}, false, {
      pool,
      // Another conversation needs a server the moment this session opens.
      onChange: () => {
        evicted ??= pool.evict() ?? null;
      },
    });
    await expect(sessions.deliver("a", "one", 1)).resolves.toEqual({
      ok: true,
    });
    expect(evicted).toBeNull();
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual(["one"]);
  });

  it("asks for a server only once the session closed to make room has stopped", async () => {
    const pool = new ServerPool(1);
    const { release, serve } = host(1);
    const { fake, sessions } = setup({}, false, { pool, serve });
    await sessions.deliver("a", "one", 1);
    const second = sessions.deliver("b", "two", 2);
    await flush(30);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.servers).toHaveLength(1);
    release();
    await expect(second).resolves.toEqual({ ok: true });
    expect(sessions.snapshot().map((live) => live.key)).toEqual(["b"]);
  });

  it("makes room and tries once more when the host has no server free", async () => {
    // Other plugins hold the host's other servers.
    const { release, serve } = host(1);
    const { fake, sessions } = setup({}, false, { serve });
    await sessions.deliver("a", "one", 1);
    const second = sessions.deliver("b", "two", 2);
    await flush(30);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.servers).toHaveLength(1);
    release();
    await expect(second).resolves.toEqual({ ok: true });
    expect(sessions.snapshot().map((live) => live.key)).toEqual(["b"]);
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
