import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Choice,
  REQUEST_TIMEOUT_MS,
  type ServeMcp,
  type ToolServer,
} from "./goose";
import { fakeSpawn, flush, type FakeThinking } from "./goose-testing";
import {
  AgentSessions,
  IDLE_MS,
  type Launch,
  localSessions,
  type SavedConversation,
  ServerPool,
  SharedProcess,
} from "./sessions";

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

/** A goose shared by agents, and its first agent's sessions. */
const setup = (
  initial: Partial<Launch> = {},
  hold = false,
  {
    pool = new ServerPool(),
    serve,
    silent,
    onChange,
    store,
    thinking,
  }: Readonly<{
    pool?: ServerPool;
    onChange?: () => void;
    store?: Map<string, SavedConversation>;
    /** Wraps the fake's `serve`. */
    serve?: (serve: ServeMcp) => ServeMcp;
    silent?: readonly string[];
    thinking?: FakeThinking;
  }> = {},
) => {
  const fake = fakeSpawn({
    home: "/home/test",
    hold,
    ...(silent && { silent }),
    thinking: thinking ?? {
      "": { current: "medium", levels: ["low", "medium", "high", "max"] },
    },
    providers: [{ providerId: "openai", defaultModel: "gpt-default" }],
  });
  const process = new SharedProcess(
    fake,
    serve ? serve(fake.serve) : fake.serve,
  );
  /** Another agent in the same goose. */
  const agent = (
    initial: Partial<Launch> = {},
    agentTools: ToolServer = tools,
    onChange?: () => void,
  ) => {
    let settings: Launch = {
      workspace: "~/.buzz",
      systemPrompt: "prompt",
      ...initial,
    };
    let choice: Choice = { provider: "", model: "" };
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools: agentTools,
      process,
      pool,
      ...(onChange && { onChange }),
      ...(store && {
        store: { set: (key: string, saved) => void store.set(key, saved) },
      }),
      launch: async () => settings,
      choice: () => choice,
      fingerprint: () =>
        JSON.stringify([settings.workspace, settings.systemPrompt]),
    });
    return {
      sessions,
      change: (next: Partial<Launch>, reconfigure = true) => {
        settings = { ...settings, ...next };
        if (reconfigure) sessions.reconfigure();
      },
      /** Picks a provider and model, as saving the agent's settings does. */
      choose: (next: Choice) => {
        choice = next;
        sessions.reconfigure();
      },
    };
  };
  return { fake, pool, process, agent, ...agent(initial, tools, onChange) };
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
    expect(fake.geese[0]?.options.cwd).toBe("/home/test");
    expect(fake.geese[0]?.opened[0]?.cwd).toBe("/home/test/.buzz");
  });

  it("opens every agent's sessions in one goose, each in its workspace with its tools", async () => {
    const { fake, sessions, agent } = setup();
    const ada = vi.fn(tools);
    const bo = vi.fn(tools);
    const first = agent({ workspace: "~/ada" }, ada);
    const second = agent({ workspace: "/work/bo" }, bo);
    await first.sessions.deliver("chan/root", "one", 1);
    await second.sessions.deliver("chan/root", "two", 2);
    await sessions.deliver("chan/root", "three", 3);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.opened.map((session) => session.cwd)).toEqual([
      "/home/test/ada",
      "/work/bo",
      "/home/test/.buzz",
    ]);
    await goose?.mcp("session-2", "tools/list");
    expect(ada).not.toHaveBeenCalled();
    expect(bo).toHaveBeenCalledWith("chan/root", {
      id: expect.anything(),
      method: "tools/list",
      params: {},
    });
    await goose?.mcp("session-1", "tools/list");
    expect(ada).toHaveBeenCalledOnce();
    expect(bo).toHaveBeenCalledOnce();
  });

  it("opens one session for messages that arrive together", async () => {
    const { fake, sessions } = setup();
    await Promise.all([
      sessions.deliver("a", "one", 1),
      sessions.deliver("a", "two", 2),
    ]);
    expect(fake.geese[0]?.opened).toHaveLength(1);
  });

  it("interrupts the turn running in a conversation, and no other", async () => {
    const { fake, sessions } = setup({}, true);
    const one = sessions.deliver("a", "one", 1);
    const other = sessions.deliver("b", "other", 2);
    await flush(20);
    const [first, second] = fake.geese[0]?.turns ?? [];
    expect(first?.text).toContain("one");
    await sessions.interrupt("a");
    await flush();
    expect(fake.geese[0]?.cancelled).toEqual([first?.sessionId]);
    await expect(one).resolves.toMatchObject({ ok: true });
    second?.finish();
    await expect(other).resolves.toMatchObject({ ok: true });
  });

  it("interrupts a conversation once the session opening for it has its message", async () => {
    const { fake, sessions } = setup({}, true);
    const delivered = sessions.deliver("a", "one", 1);
    // Asked while the session still opens.
    await sessions.interrupt("a");
    await flush();
    expect(fake.geese[0]?.turns).toHaveLength(1);
    expect(fake.geese[0]?.cancelled).toEqual([
      fake.geese[0]?.turns[0]?.sessionId,
    ]);
    await expect(delivered).resolves.toMatchObject({ ok: true });
  });

  it("does nothing when asked to interrupt a conversation with no session", async () => {
    const { fake, sessions } = setup();
    await expect(sessions.interrupt("none")).resolves.toBeUndefined();
    await sessions.deliver("a", "one", 1);
    await sessions.interrupt("a");
    expect(fake.geese[0]?.cancelled).toEqual([]);
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

  it("leaves only a conversation's first session for goose to name", async () => {
    const { fake, sessions, change } = setup();
    const named = vi.fn();
    await sessions.deliver("a", "one", 1, { title: "Buzz", named });
    change({ systemPrompt: "newer" }, false);
    await sessions.deliver("a", "two", 2, { title: "Buzz", named });
    // A reopened session would cost another naming call for a named chat.
    expect(
      fake.geese[0]?.opened.map(
        (session) => (session._meta as { sessionTitle?: string }).sessionTitle,
      ),
    ).toEqual([undefined, "Buzz"]);
  });

  it("switches the live session's provider and model between turns", async () => {
    const { fake, sessions, choose } = setup();
    await sessions.deliver("a", "one", 1);
    choose({ provider: "openai", model: "" });
    await sessions.deliver("a", "two", 2);
    choose({ provider: "openai", model: "gpt-4.1" });
    await sessions.deliver("a", "three", 3);
    choose({ provider: "openai", model: "" });
    await sessions.deliver("a", "four", 4);
    choose({ provider: "", model: "" });
    await sessions.deliver("a", "five", 5);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.opened[0]?._meta).not.toHaveProperty("provider");
    expect(goose?.closed).toEqual([]);
    expect(new Set(goose?.turns.map((turn) => turn.sessionId))).toEqual(
      new Set(["session-1"]),
    );
    // A provider alone runs on its default model; `goose` is goose's config.
    expect(goose?.configured).toEqual([
      "session-1 provider=openai",
      "session-1 model=gpt-4.1",
      "session-1 model=gpt-default",
      "session-1 provider=goose",
    ]);
  });

  it("opens a session on the agent's provider, and sets its model before the turn", async () => {
    const { fake, sessions, choose } = setup();
    choose({ provider: "openai", model: "gpt-4.1" });
    await sessions.deliver("a", "one", 1);
    const [goose] = fake.geese;
    expect(goose?.env).toMatchObject({
      GOOSE_PROVIDER: null,
      GOOSE_MODEL: null,
    });
    expect(goose?.opened[0]?._meta).toMatchObject({ provider: "openai" });
    expect(goose?.configured).toEqual(["session-1 model=gpt-4.1"]);
    const methods = goose?.received.map((message) => message.method) ?? [];
    expect(methods.indexOf("session/set_config_option")).toBeLessThan(
      methods.indexOf("session/prompt"),
    );
  });

  it("applies a provider change made during a turn at the next turn", async () => {
    const { fake, sessions, choose } = setup({}, true);
    const first = sessions.deliver("a", "one", 1);
    await flush(30);
    choose({ provider: "openai", model: "" });
    const second = sessions.deliver("a", "two", 2);
    await flush(30);
    const [goose] = fake.geese;
    expect(goose?.turns[0]?.steered).toEqual(["two"]);
    expect(goose?.configured).toEqual([]);
    goose?.turns[0]?.finish();
    await Promise.all([first, second]);
    const third = sessions.deliver("a", "three", 3);
    await flush(30);
    expect(goose?.configured).toEqual(["session-1 provider=openai"]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one", "three"]);
    goose?.turns[1]?.finish();
    await expect(third).resolves.toEqual({ ok: true });
    expect(fake.geese).toHaveLength(1);
  });

  it("runs a turn on the model its message asked for, and the next on the agent's", async () => {
    const { fake, sessions, choose } = setup();
    choose({ provider: "openai", model: "" });
    await sessions.deliver("a", "one", 1, { model: "gpt-4.1" });
    await sessions.deliver("a", "two", 2);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=gpt-4.1",
      "session-1 model=gpt-default",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
    ]);
  });

  it("puts the live session on a chosen thinking level, and a new one on goose's own", async () => {
    const { fake, sessions, choose } = setup();
    await sessions.deliver("a", "one", 1);
    choose({ provider: "", model: "", effort: "high" });
    await sessions.deliver("a", "two", 2);
    choose({ provider: "openai", model: "", effort: "high" });
    await sessions.deliver("a", "three", 3);
    choose({ provider: "openai", model: "", effort: "low" });
    await sessions.deliver("a", "four", 4);
    const [goose] = fake.geese;
    // goose keeps a level across providers: it is set only when it changes.
    expect(goose?.configured).toEqual([
      "session-1 thinking_effort=high",
      "session-1 provider=openai",
      "session-1 thinking_effort=low",
    ]);
    expect(goose?.closed).toEqual([]);
    // goose names no value for its own level, so only a new session is on it.
    choose({ provider: "openai", model: "" });
    await flush();
    expect(goose?.closed).toEqual(["session-1"]);
    await sessions.deliver("a", "five", 5);
    expect(goose?.turns.map((turn) => turn.sessionId).at(-1)).toBe("session-2");
    expect(goose?.configured).toHaveLength(3);
  });

  it("queues a message effort for its turn and restores the session baseline", async () => {
    const { fake, sessions } = setup({}, true);
    const first = sessions.deliver("a", "one", 1);
    await expect.poll(() => fake.geese[0]?.turns.length).toBe(1);
    const goose = fake.geese[0];
    const picked = sessions.deliver("a", "two", 2, {
      effort: "high",
      steer: "Continue the current task instead.",
    });
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one"]);
    const fallback = sessions.deliver("a", "three", 3, {
      steer: "Continue the current task instead.",
    });

    goose?.turns[0]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(2);
    expect(goose?.configured).toEqual(["session-1 thinking_effort=high"]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one", "two"]);
    goose?.turns[1]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(3);
    expect(goose?.configured).toEqual([
      "session-1 thinking_effort=high",
      "session-1 thinking_effort=medium",
    ]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    goose?.turns[2]?.finish();
    await Promise.all([first, picked, fallback]);
  });

  it("uses a saved thinking level instead of the session baseline", async () => {
    const { fake, sessions, choose } = setup({}, false, {
      thinking: { "": { current: "low", levels: ["low", "medium", "high"] } },
    });
    choose({ provider: "", model: "", effort: "medium" });
    await sessions.deliver("a", "one", 1);
    await sessions.deliver("a", "two", 2, { effort: "high" });
    await sessions.deliver("a", "three", 3);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 thinking_effort=medium",
      "session-1 thinking_effort=high",
      "session-1 thinking_effort=medium",
    ]);
  });

  it("restores a supported effort when the session baseline is unavailable", async () => {
    const { fake, sessions, choose } = setup({}, true, {
      thinking: {
        "": { current: "medium", levels: ["low", "medium"] },
        "model-a": { current: "medium", levels: ["high", "max"] },
      },
    });
    choose({ provider: "", model: "model-a" });
    const picked = sessions.deliver("a", "picked", 1, {
      model: "model-a",
      effort: "max",
    });
    await expect.poll(() => fake.geese[0]?.turns.length).toBe(1);
    const goose = fake.geese[0];
    goose?.turns[0]?.finish();
    await picked;

    const ordinary = sessions.deliver("a", "ordinary", 2);
    await expect.poll(() => goose?.turns.length).toBe(2);
    expect(goose?.configured).toEqual([
      "session-1 model=model-a",
      "session-1 thinking_effort=max",
      "session-1 thinking_effort=high",
    ]);
    goose?.turns[1]?.finish();
    await ordinary;
  });

  it.each(["end_turn", "refusal"])(
    "keeps a queued turn separate from post-final output (%s)",
    async (stopReason) => {
      const { fake, sessions } = setup({}, true);
      const picked = sessions.deliver("a", "picked", 1, { effort: "high" });
      await expect.poll(() => fake.geese[0]?.turns.length).toBe(1);
      const goose = fake.geese[0];
      await goose?.mcp("session-1", "tools/call", {
        name: "send",
        arguments: { final: true },
      });
      await expect(picked).resolves.toEqual({ ok: true });

      const acknowledged = vi.fn();
      const ordinary = sessions.deliver("a", "ordinary", 2, {
        step: () => {},
        acknowledged,
      });
      await expect.poll(() => acknowledged.mock.calls.length).toBe(1);
      expect(goose?.turns).toHaveLength(1);
      expect(goose?.turns[0]?.steered).toEqual([]);
      goose?.update("session-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Already answered. " },
      });
      goose?.turns[0]?.finish(stopReason);
      await expect.poll(() => goose?.turns.length).toBe(2);
      expect(goose?.configured).toEqual([
        "session-1 thinking_effort=high",
        "session-1 thinking_effort=medium",
      ]);
      goose?.update("session-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Ordinary answer." },
      });
      goose?.turns[1]?.finish();
      await expect(ordinary).resolves.toEqual({
        ok: true,
        text: "Ordinary answer.",
      });
    },
  );

  it("keeps the session baseline when Goose carries saved thinking across a model switch", async () => {
    const { fake, sessions, choose } = setup({}, true, {
      thinking: {
        "": { current: "medium", levels: ["low", "medium", "high"] },
        "model-a": { current: "medium", levels: ["low", "medium", "high"] },
        "model-b": { current: "low", levels: ["low", "medium", "high"] },
      },
    });
    choose({ provider: "", model: "model-a", effort: "high" });
    const first = sessions.deliver("a", "one", 1, { model: "model-a" });
    await expect.poll(() => fake.geese[0]?.turns.length).toBe(1);
    const goose = fake.geese[0];

    choose({ provider: "", model: "model-b", effort: "high" });
    const second = sessions.deliver("a", "two", 2, { model: "model-b" });
    goose?.turns[0]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(2);

    choose({ provider: "", model: "model-b", effort: "" });
    const picked = sessions.deliver("a", "three", 3, { effort: "low" });
    const fallback = sessions.deliver("a", "four", 4);
    goose?.turns[1]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(3);
    expect(goose?.configured).toEqual([
      "session-1 model=model-a",
      "session-1 thinking_effort=high",
      "session-1 model=model-b",
      "session-1 thinking_effort=low",
    ]);

    goose?.turns[2]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(4);
    expect(goose?.configured).toEqual([
      "session-1 model=model-a",
      "session-1 thinking_effort=high",
      "session-1 model=model-b",
      "session-1 thinking_effort=low",
      "session-1 thinking_effort=medium",
    ]);
    goose?.turns[3]?.finish();
    await Promise.all([first, second, picked, fallback]);
  });

  it("restores thinking after switching away from a queued message override", async () => {
    const { fake, sessions, choose } = setup({}, true, {
      thinking: {
        "gpt-default": { current: "low", levels: ["low", "high"] },
        "picked-model": { current: "high", levels: ["high", "max"] },
      },
    });
    choose({ provider: "openai", model: "", effort: "low" });
    const first = sessions.deliver("a", "one", 1, {
      model: "picked-model",
      effort: "max",
    });
    await expect.poll(() => fake.geese[0]?.turns.length).toBe(1);
    const goose = fake.geese[0];

    const second = sessions.deliver("a", "two", 2, { model: "gpt-default" });
    goose?.turns[0]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(2);
    expect(goose?.configured).toEqual([
      "session-1 model=picked-model",
      "session-1 thinking_effort=max",
      "session-1 model=gpt-default",
      "session-1 thinking_effort=low",
    ]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one", "two"]);

    goose?.turns[1]?.finish();
    await Promise.all([first, second]);
  });

  it("keeps saved thinking when a switched model reports no effort levels", async () => {
    const { fake, sessions, choose } = setup({}, false, {
      thinking: {
        "model-with-effort": {
          current: "low",
          levels: ["low", "high"],
        },
      },
    });
    choose({ provider: "", model: "model-with-effort", effort: "high" });
    await expect(sessions.deliver("a", "one", 1)).resolves.toMatchObject({
      ok: true,
    });
    choose({ provider: "", model: "model-without-effort", effort: "high" });
    await expect(sessions.deliver("a", "two", 2)).resolves.toMatchObject({
      ok: true,
    });
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual([
      "one",
      "two",
    ]);
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=model-with-effort",
      "session-1 thinking_effort=high",
      "session-1 model=model-without-effort",
    ]);
  });

  it("does not let an unsupported fallback block the next model's prompt", async () => {
    const { fake, sessions, choose } = setup({}, false, {
      thinking: {
        "model-with-effort": { current: "medium", levels: ["medium", "high"] },
      },
    });
    choose({ provider: "", model: "model-with-effort", effort: "medium" });
    await sessions.deliver("a", "explicit high", 1, { effort: "high" });

    choose({ provider: "", model: "model-without-effort", effort: "medium" });
    await expect(sessions.deliver("a", "ordinary", 2)).resolves.toMatchObject({
      ok: true,
    });

    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=model-with-effort",
      "session-1 thinking_effort=high",
      "session-1 model=model-without-effort",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual([
      "explicit high",
      "ordinary",
    ]);
  });

  it("restores a supported fallback when the selected model lacks saved effort", async () => {
    const { fake, sessions, choose } = setup({}, false, {
      thinking: {
        "model-with-off": { current: "off", levels: ["off", "low", "high"] },
        "model-without-off": { current: "low", levels: ["low", "high", "max"] },
      },
    });
    choose({ provider: "", model: "model-with-off", effort: "off" });

    await sessions.deliver("a", "picked", 1, {
      model: "model-with-off",
      effort: "high",
    });
    await sessions.deliver("a", "model-only", 2, {
      model: "model-without-off",
    });

    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=model-with-off",
      "session-1 thinking_effort=high",
      "session-1 model=model-without-off",
      "session-1 thinking_effort=low",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual([
      "picked",
      "model-only",
    ]);
  });

  it("restores the baseline after returning from a model without effort support", async () => {
    const { fake, sessions } = setup({}, false, {
      thinking: {
        "": { current: "medium", levels: ["low", "medium", "high"] },
        "model-with-effort": {
          current: "medium",
          levels: ["low", "medium", "high"],
        },
      },
    });

    await sessions.deliver("a", "picked", 1, {
      model: "model-with-effort",
      effort: "high",
    });
    await sessions.deliver("a", "unsupported", 2, {
      model: "model-without-effort",
    });
    await sessions.deliver("a", "returned", 3, {
      model: "model-with-effort",
    });

    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=model-with-effort",
      "session-1 thinking_effort=high",
      "session-1 model=model-without-effort",
      "session-1 model=model-with-effort",
      "session-1 thinking_effort=medium",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual([
      "picked",
      "unsupported",
      "returned",
    ]);
  });

  it("uses a supported fallback when the opening session has no baseline", async () => {
    const { fake, sessions, choose } = setup({}, false, {
      thinking: {
        "model-with-effort": { current: "low", levels: ["low", "high"] },
      },
    });
    choose({ provider: "openai", model: "model-with-effort" });

    await sessions.deliver("a", "picked", 1, {
      model: "model-with-effort",
      effort: "high",
    });
    await sessions.deliver("a", "ordinary", 2);

    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=model-with-effort",
      "session-1 thinking_effort=high",
      "session-1 thinking_effort=low",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual([
      "picked",
      "ordinary",
    ]);
  });

  it("rejects an empty message effort before switching its model", async () => {
    const { fake, sessions } = setup({}, false, {
      thinking: {
        "picked-model": { current: "medium", levels: ["low", "medium"] },
      },
    });
    await expect(
      sessions.deliver("a", "one", 1, {
        model: "picked-model",
        effort: "",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "goose cannot apply an empty thinking_effort",
    });
    expect(fake.geese[0]?.configured).toEqual([]);
    expect(fake.geese[0]?.turns).toEqual([]);
  });

  it("restores the baseline before retiring a session with a cleared saved effort", async () => {
    const { fake, sessions, choose } = setup({}, true, {
      thinking: { "": { current: "low", levels: ["low", "medium", "high"] } },
    });
    choose({ provider: "", model: "", effort: "medium" });
    const first = sessions.deliver("a", "one", 1);
    await expect.poll(() => fake.geese[0]?.turns.length).toBe(1);

    choose({ provider: "", model: "", effort: "" });
    const picked = sessions.deliver("a", "two", 2, { effort: "high" });
    const fallback = sessions.deliver("a", "three", 3);
    const goose = fake.geese[0];
    goose?.turns[0]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(2);
    goose?.turns[1]?.finish();
    await expect.poll(() => goose?.turns.length).toBe(3);
    goose?.turns[2]?.finish();
    await Promise.all([first, picked, fallback]);

    const fourth = sessions.deliver("a", "four", 4);
    await expect.poll(() => goose?.turns.length).toBe(4);
    goose?.turns[3]?.finish();
    await fourth;
    expect(goose?.configured).toEqual([
      "session-1 thinking_effort=medium",
      "session-1 thinking_effort=high",
      "session-1 thinking_effort=low",
    ]);
    expect(goose?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-1",
      "session-1",
      "session-2",
    ]);
  });

  it("surfaces a per-message effort goose does not offer", async () => {
    const { fake, sessions } = setup({}, false, {
      thinking: { "": { current: "low", levels: ["low", "high"] } },
    });
    await sessions.deliver("a", "picked", 1, { effort: "high" });
    await expect(
      sessions.deliver("a", "unsupported", 2, { effort: "ultra" }),
    ).resolves.toEqual({
      ok: false,
      error: "goose does not support thinking_effort ultra",
    });
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 thinking_effort=high",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual(["picked"]);
  });

  it("stops advertising old efforts after switching to a model without them", async () => {
    const { fake, sessions } = setup({}, false, {
      thinking: {
        "model-with-effort": {
          current: "medium",
          levels: ["low", "medium", "high"],
        },
      },
    });
    await sessions.deliver("a", "supported", 1, {
      model: "model-with-effort",
    });
    await sessions.deliver("a", "unsupported", 2, {
      model: "model-without-effort",
    });

    await expect(
      sessions.deliver("a", "invalid", 3, {
        model: "model-without-effort",
        effort: "high",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "goose does not support thinking_effort high",
    });
    expect(fake.geese[0]?.configured).toEqual([
      "session-1 model=model-with-effort",
      "session-1 model=model-without-effort",
    ]);
    expect(fake.geese[0]?.turns.map((turn) => turn.text)).toEqual([
      "supported",
      "unsupported",
    ]);
  });

  it("does not change Goose thinking when neither a message nor saved pick exists", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await sessions.deliver("a", "two", 2);
    expect(fake.geese[0]?.configured).toEqual([]);
  });

  it("fails a turn goose cannot switch, and switches at the next", async () => {
    const { fake, sessions, choose } = setup();
    await sessions.deliver("a", "one", 1);
    const [goose] = fake.geese;
    if (goose) goose.configError = "Unknown provider";
    choose({ provider: "nope", model: "" });
    await expect(sessions.deliver("a", "two", 2)).resolves.toEqual({
      ok: false,
      error: "goose could not switch its provider to nope: Unknown provider",
    });
    expect(goose?.turns).toHaveLength(1);
    if (goose) delete goose.configError;
    await expect(sessions.deliver("a", "three", 3)).resolves.toEqual({
      ok: true,
    });
    expect(goose?.configured).toEqual(["session-1 provider=nope"]);
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one", "three"]);
  });

  it("reopens an idle session in a new workspace, in the same goose", async () => {
    const { fake, sessions, change } = setup();
    await sessions.deliver("a", "one", 1);
    change({ workspace: "~/other" });
    await sessions.deliver("a", "two", 2);
    expect(fake.geese).toHaveLength(1);
    const [goose] = fake.geese;
    expect(goose?.closed).toEqual(["session-1"]);
    expect(goose?.opened.map((session) => session.cwd)).toEqual([
      "/home/test/.buzz",
      "/home/test/other",
    ]);
    expect(goose?.killed).toBe(false);
  });

  it("reports a failed immediate compaction", async () => {
    const { fake, sessions } = setup();
    // Without a session there is nothing to compact.
    await expect(sessions.reset("a", "compact")).resolves.toEqual({ ok: true });
    await sessions.deliver("a", "one", 1);
    const goose = fake.geese[0];
    expect(goose?.turns.map((turn) => turn.text)).toEqual(["one"]);
    if (goose) goose.hold = true;
    const compacted = sessions.reset("a", "compact");
    await flush(30);
    // goose ends a failed compaction like any turn, saying why in its text.
    goose?.update("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Request failed: Resource not found (404)",
      },
    });
    await flush(30);
    goose?.turns[1]?.finish();
    await expect(compacted).resolves.toEqual({
      ok: false,
      error: "Request failed: Resource not found (404)",
    });
    expect(goose?.turns).toHaveLength(2);
  });

  it("answers in a new session when asked to", async () => {
    const { fake, sessions } = setup();
    await sessions.deliver("a", "one", 1);
    await sessions.reset("a", "new");
    await sessions.deliver("a", "two", 2);
    expect(fake.geese[0]?.closed).toEqual(["session-1"]);
    expect(fake.geese[0]?.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
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

  it("saves when each conversation last used its session, after the session closes too", async () => {
    vi.useFakeTimers();
    const store = new Map<string, SavedConversation>();
    const { sessions } = setup({}, false, { store });
    await sessions.deliver("a", "one", 1);
    const at = sessions.snapshot()[0]?.at;
    expect(store.get("a")).toEqual({ at });
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(sessions.snapshot()).toEqual([]);
    expect(store.get("a")).toEqual({ at });
    // A one-off turn joins no conversation.
    await sessions.runOnce("watch/x", () => "look");
    expect([...store.keys()]).toEqual(["a"]);
  });

  it("dates a session by the messages it takes in and the turns it ends, not by a long turn keeping it open", async () => {
    vi.useFakeTimers();
    const { fake, sessions } = setup({}, true);
    const at = () => sessions.snapshot()[0]?.at ?? 0;
    const done = sessions.deliver("a", "one", 1);
    await vi.advanceTimersByTimeAsync(10);
    const started = at();
    expect(started).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(sessions.snapshot()).toMatchObject([{ key: "a", busy: true }]);
    expect(at()).toBe(started);
    fake.geese[0]?.turns[0]?.finish();
    await done;
    expect(at()).toBeGreaterThan(started);
  });

  it("drops every agent's sessions when goose exits, and starts it again", async () => {
    const { fake, sessions, agent } = setup();
    const other = agent();
    await sessions.deliver("a", "one", 1);
    await other.sessions.deliver("a", "two", 2);
    fake.geese[0]?.exit(1, "crashed");
    await flush(30);
    expect(sessions.snapshot()).toEqual([]);
    expect(other.sessions.snapshot()).toEqual([]);
    await expect(sessions.deliver("a", "three", 3)).resolves.toEqual({
      ok: true,
    });
    await expect(other.sessions.deliver("a", "four", 4)).resolves.toEqual({
      ok: true,
    });
    expect(fake.geese).toHaveLength(2);
    expect(fake.geese[1]?.opened).toHaveLength(2);
  });

  it("saves no conversation whose first message gave up before the session opened", async () => {
    const fake = fakeSpawn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new Map<string, SavedConversation>();
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new SharedProcess(fake, fake.serve),
      pool: new ServerPool(),
      store: { set: (key, saved) => void store.set(key, saved) },
      launch: async () => {
        await held;
        return { workspace: "/w", systemPrompt: "" };
      },
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const abort = new AbortController();
    const late = sessions.deliver("a", "one", 1, { signal: abort.signal });
    await flush(30);
    abort.abort();
    await expect(late).resolves.toMatchObject({ ok: false });
    release();
    await flush(30);
    expect(sessions.snapshot()).toMatchObject([{ key: "a" }]);
    expect(store.size).toBe(0);
    await sessions.deliver("a", "two", 2);
    expect(store.has("a")).toBe(true);
    sessions.dispose();
  });

  it("reports why goose could not start", async () => {
    const fake = fakeSpawn({ http: false });
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new SharedProcess(fake, fake.serve),
      pool: new ServerPool(),
      launch: async () => ({ workspace: "/w", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    await expect(sessions.deliver("a", "one", 1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/HTTP MCP/),
      undelivered: true,
    });
  });

  it("starts no goose for an agent removed while its sessions open", async () => {
    const fake = fakeSpawn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = vi.fn(async () => {
      await held;
      return { workspace: "/w", systemPrompt: "" };
    });
    const sessions = new AgentSessions({
      resolveDirectory: fake.resolveDirectory,
      tools,
      process: new SharedProcess(fake, fake.serve),
      pool: new ServerPool(),
      launch,
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const delivering = sessions.deliver("a", "one", 1);
    const once = sessions.runOnce("watch/x", () => "look");
    await flush(30);
    expect(launch).toHaveBeenCalledTimes(2);
    sessions.dispose();
    release();
    await expect(delivering).resolves.toEqual({
      ok: false,
      error: "goose was stopped",
      undelivered: true,
    });
    await expect(once).resolves.toMatchObject({ ok: false });
    await flush(30);
    expect(fake.geese).toEqual([]);
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
      { key: "a", busy: false, sessionId: "session-2", at: Date.now() },
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
      undelivered: true,
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
      undelivered: true,
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
      undelivered: true,
    });
    expect(fake.geese[0]?.killed).toBe(true);
    expect(fake.servers.map((server) => server.closed)).toEqual([true]);
    expect(pool.size).toBe(0);
  });

  it("closes the least recently used idle session of any agent to make room", async () => {
    const pool = new ServerPool(2);
    const { fake, sessions: one, agent } = setup({}, false, { pool });
    const two = agent().sessions;
    await one.deliver("a", "one", 1);
    await one.deliver("b", "two", 2);
    await one.deliver("a", "three", 3);
    // `b` is now the least recently used.
    const [goose] = fake.geese;
    if (goose) goose.hold = true;
    const working = two.deliver("c", "four", 4);
    await flush(30);
    expect(goose?.closed).toEqual(["session-2"]);
    expect(one.snapshot().map((live) => live.key)).toEqual(["a"]);
    // `c` is working, so `a` closes for the next.
    if (goose) goose.hold = false;
    await one.deliver("d", "five", 5);
    expect(goose?.closed).toEqual(["session-2", "session-1"]);
    expect(two.snapshot().map((live) => live.key)).toEqual(["c"]);
    expect(pool.size).toBe(2);
    goose?.turns.find((turn) => turn.text === "four")?.finish();
    await working;
  });

  it("never closes a new session to make room before its first message is sent", async () => {
    const pool = new ServerPool(1);
    let evicted: unknown;
    const { fake, sessions } = setup({}, false, {
      pool,
      // Another conversation needs a server the moment this session opens.
      onChange: () => {
        if (fake.geese[0]?.turns.length) return;
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

  it("closes only its own sessions when disposed, ending their turns", async () => {
    const { fake, sessions, agent } = setup();
    const other = agent();
    await other.sessions.deliver("a", "one", 1);
    const [goose] = fake.geese;
    if (goose) goose.hold = true;
    const working = sessions.deliver("a", "two", 2);
    await flush(30);
    sessions.dispose();
    await expect(working).resolves.toEqual({
      ok: false,
      error: "The session was closed",
    });
    await flush(30);
    expect(goose?.closed).toEqual(["session-2"]);
    expect(goose?.killed).toBe(false);
    await expect(sessions.deliver("a", "three", 3)).resolves.toMatchObject({
      ok: false,
    });
    expect(other.sessions.snapshot().map((live) => live.key)).toEqual(["a"]);
  });
});

it("keeps saved conversations per agent in storage, most recent first", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const one = localSessions(storage, "one");
  one.set("c/root", { at: 1 });
  one.set("dm", { at: 3 });
  localSessions(storage, "two").set("c/root", { at: 2 });
  expect(localSessions(storage, "one").list()).toEqual([
    ["dm", { at: 3 }],
    ["c/root", { at: 1 }],
  ]);
  expect(localSessions(storage, "two").list()).toEqual([["c/root", { at: 2 }]]);
  data.set("buzz.goose.sessions.v1", "not json");
  expect(one.list()).toEqual([]);
});
