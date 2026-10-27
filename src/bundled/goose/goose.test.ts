import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GooseProcess,
  REQUEST_TIMEOUT_MS,
  stepLabel,
  type ToolServer,
} from "./goose";
import { fakeSpawn, flush } from "./goose-testing";

const ok: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: { content: [{ type: "text", text: "done" }] },
});

const start = async (tools: ToolServer = ok, silent?: readonly string[]) => {
  const fake = fakeSpawn(silent ? { silent } : {});
  const goose = await GooseProcess.start(fake.spawn, {
    cwd: "/work",
    serve: fake.serve,
  });
  const [process] = fake.geese;
  if (!process) throw new Error("goose did not start");
  /** Opens a session in /work whose Buzz tools `tools` answers. */
  const open = (launch: Partial<Parameters<GooseProcess["open"]>[0]> = {}) =>
    goose.open({ cwd: "/work", systemPrompt: "", tools, ...launch });
  return { goose, open, process, fake };
};

/** A goose whose answers to `method` wait until `release`, as a slow one's
 * do; `reject` makes the answer a JSON-RPC error. */
const slow = async (method: string, reject = false) => {
  const fake = fakeSpawn();
  let release!: () => void;
  /** How many requests for `method` are waiting. */
  let waiting = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spawn: typeof fake.spawn = async (id, options = {}) => {
    const process = await fake.spawn(id, options);
    return {
      ...process,
      write: async (data) => {
        if (id !== "goose" || !data.includes(`"method":"${method}"`))
          return process.write(data);
        waiting++;
        await gate;
        if (!reject) return process.write(data);
        const { id: requestId } = JSON.parse(data);
        options.onStdout?.(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: { code: -32602, message: "No active run" },
          })}\n`,
        );
      },
    };
  };
  const goose = await GooseProcess.start(spawn, {
    cwd: "/work",
    serve: fake.serve,
  });
  const [process] = fake.geese;
  if (!process) throw new Error("goose did not start");
  return { goose, process, release, waiting: () => waiting };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("GooseProcess", () => {
  it("starts goose-acp without the app's Buzz identity or goose choice", async () => {
    const { process } = await start();
    expect(process.options.cwd).toBe("/work");
    expect(process.options.env).toMatchObject({
      GOOSE_MODE: "auto",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
      BUZZ_RELAY_URL: null,
      GOOSE_PROVIDER: null,
      GOOSE_MODEL: null,
    });
  });

  it("points goose's Databricks provider at a packaged workspace", async () => {
    expect((await start()).process.options.env).not.toHaveProperty(
      "DATABRICKS_HOST",
    );
    vi.stubEnv("VITE_BUZZ_DATABRICKS_HOST", "https://workspace.example/");
    try {
      expect((await start()).process.options.env).toMatchObject({
        DATABRICKS_HOST: "https://workspace.example/",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a goose that cannot serve the Buzz tools", async () => {
    const fake = fakeSpawn({ http: false });
    await expect(
      GooseProcess.start(fake.spawn, { cwd: "/work" }),
    ).rejects.toThrow(/HTTP MCP/);
    expect(fake.geese[0]?.killed).toBe(true);
  });

  it("opens a session with its own Buzz MCP server and its system prompt", async () => {
    const { open, process, fake } = await start();
    const session = await open({ systemPrompt: "Be Buzz" });
    const buzz = {
      type: "http",
      name: "buzz",
      url: "http://127.0.0.1:40001/mcp",
      headers: [{ name: "Authorization", value: "Bearer token-1" }],
    };
    expect(fake.servers).toHaveLength(1);
    expect(process.opened).toEqual([
      {
        cwd: "/work",
        mcpServers: [buzz],
        _meta: {
          enabledExtensions: [
            { type: "platform", name: "developer" },
            { type: "mcp", server: buzz },
          ],
        },
      },
    ]);
    expect(process.prompts.get(session.id)).toBe("Be Buzz");
  });

  it("gives each session its own server, closed with it", async () => {
    const { goose, open, fake } = await start();
    const first = await open();
    await open();
    // One without tools has no server.
    await goose.open({ cwd: "/work", systemPrompt: "" });
    expect(fake.servers.map((server) => server.url)).toEqual([
      "http://127.0.0.1:40001/mcp",
      "http://127.0.0.1:40002/mcp",
    ]);
    await goose.close(first);
    expect(fake.servers.map((server) => server.closed)).toEqual([true, false]);
  });

  it("closes a session whose server the host stopped", async () => {
    const { open, process, fake } = await start();
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    fake.servers[0]?.stop();
    await expect(settled).resolves.toEqual({
      ok: false,
      error:
        "Buzz stopped this session's tools: another program used their token",
    });
    expect(session.open).toBe(false);
    await flush();
    expect(process.closed).toEqual([session.id]);
  });

  it("closes the session servers when goose exits", async () => {
    const { goose, open, process, fake } = await start();
    await open();
    process.exit(1, "boom");
    await goose.exited;
    expect(fake.servers[0]?.closed).toBe(true);
  });

  it("settles a message when its turn ends", async () => {
    const { open, process } = await start();
    const session = await open();
    await expect(session.send("hello")).resolves.toEqual({ ok: true });
    expect(process.turns.map((turn) => turn.text)).toEqual(["hello"]);
    expect(session.busy).toBe(false);
  });

  it("answers the Buzz tools' MCP messages for the session's conversation", async () => {
    const tools = vi.fn(ok);
    const { open, process } = await start(tools);
    const session = await open();
    session.conversation = "channel/root";
    const response = await process.mcp(session.id, "tools/list");
    expect(tools).toHaveBeenCalledWith("channel/root", {
      id: 1,
      method: "tools/list",
      params: {},
    });
    // goose matches the reply to its request by the id it sent.
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "done" }] },
    });
  });

  it("answers no MCP notification", async () => {
    const tools = vi.fn(ok);
    const { open, fake } = await start(tools);
    await open();
    await expect(
      fake.servers[0]?.handler({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).resolves.toBeUndefined();
    expect(tools).not.toHaveBeenCalled();
  });

  it("returns a tool server's failure as the MCP error", async () => {
    const { open, process } = await start(async () => {
      throw new Error("relay down");
    });
    const session = await open();
    const response = await process.mcp(session.id, "tools/call", {
      name: "send",
      arguments: {},
    });
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "relay down" },
    });
  });

  it("counts the work done when a final send succeeds", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    await process.mcp(session.id, "tools/call", {
      name: "send",
      arguments: { content: "hi", final: true },
    });
    await expect(settled).resolves.toEqual({ ok: true });
    expect(session.busy).toBe(false);
    expect(session.working).toBe(true);
    session.interrupt();
    await flush();
    expect(process.cancelled).toEqual([session.id]);
    await session.idle();
    expect(session.working).toBe(false);
  });

  it("steers a message that arrives mid-turn into it", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const acknowledged = vi.fn();
    const first = session.send("one");
    await flush();
    const second = session.send("two", { step: () => {}, acknowledged });
    await flush();
    expect(process.turns[0]?.steered).toEqual(["two"]);
    expect(acknowledged).toHaveBeenCalled();
    process.turns[0]?.finish();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(process.turns).toHaveLength(1);
  });

  it("steers a message sent before goose names the turn", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const first = session.send("one");
    const second = session.send("two");
    await flush();
    expect(process.turns.map((turn) => [turn.text, turn.steered])).toEqual([
      ["one", ["two"]],
    ]);
    process.turns[0]?.finish();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("runs a message that asks for another model as the next turn, on it", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open({
      choice: () => ({ provider: "openai", model: "gpt-4.1" }),
    });
    const first = session.send("one");
    await flush();
    const same = session.send("two", {}, "gpt-4.1");
    const other = session.send("three", {}, "o3");
    // Steering would answer it before the turn it waits for.
    const after = session.send("four");
    await flush();
    expect(process.turns.map((turn) => [turn.text, turn.steered])).toEqual([
      ["one", ["two"]],
    ]);
    process.turns[0]?.finish();
    await flush();
    expect(process.turns.map((turn) => turn.text)).toEqual(["one", "three"]);
    process.turns[1]?.finish();
    await flush();
    process.turns[2]?.finish();
    await expect(Promise.all([first, same, other, after])).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(process.turns.map((turn) => turn.text)).toEqual([
      "one",
      "three",
      "four",
    ]);
    // Each turn on its model: the pick's, then the agent's again.
    expect(process.configured).toEqual([
      "session-1 model=gpt-4.1",
      "session-1 model=o3",
      "session-1 model=gpt-4.1",
    ]);
  });

  it("runs a message that asks for another thinking level as the next turn, on it", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open({
      choice: () => ({ provider: "openai", model: "gpt-4.1", effort: "low" }),
    });
    const first = session.send("one");
    await flush();
    const same = session.send("two", {}, undefined, "low");
    const other = session.send("three", {}, undefined, "high");
    await flush();
    expect(process.turns.map((turn) => [turn.text, turn.steered])).toEqual([
      ["one", ["two"]],
    ]);
    process.turns[0]?.finish();
    await flush();
    process.turns[1]?.finish();
    await expect(Promise.all([first, same, other])).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(process.turns.map((turn) => turn.text)).toEqual(["one", "three"]);
    expect(process.configured).toEqual([
      "session-1 model=gpt-4.1",
      "session-1 thinking_effort=low",
      "session-1 thinking_effort=high",
    ]);
    expect(session.effort).toBe("high");
  });

  it("names a session with its title", async () => {
    const { open, process } = await start();
    await open({ title: "Ada · #general" });
    expect(process.opened[0]?._meta).toMatchObject({
      sessionTitle: "Ada · #general",
    });
  });

  it("keeps a session's title when goose's config turns naming off", async () => {
    const fake = fakeSpawn({ namingDisabled: true });
    const goose = await GooseProcess.start(fake.spawn, { cwd: "/work" });
    const session = await goose.open({
      cwd: "/work",
      systemPrompt: "",
      title: "Ada · #general",
      named: vi.fn(),
    });
    expect(fake.geese[0]?.opened[0]?._meta).toMatchObject({
      sessionTitle: "Ada · #general",
    });
    expect(session.named).toBeUndefined();
  });

  it("passes on the first name goose generates for a session it names", async () => {
    const { open, process } = await start();
    const named = vi.fn();
    const session = await open({ title: "Ada · #general", named });
    expect(process.opened[0]?._meta).not.toHaveProperty("sessionTitle");
    process.update(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: "run-1" } },
    });
    process.update(session.id, {
      sessionUpdate: "session_info_update",
      title: " Fix the login bug ",
      _meta: { messageCount: 1, userSetName: false },
    });
    process.update(session.id, {
      sessionUpdate: "session_info_update",
      title: "A later name",
      _meta: { messageCount: 2, userSetName: false },
    });
    await flush();
    expect(named).toHaveBeenCalledExactlyOnceWith("Fix the login bug");
  });

  it("runs a message the turn could not take as the next turn", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const first = session.send("one");
    await flush();
    // The run ended on goose's side, but its answer has not arrived yet.
    process.update(session.id, {
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: "run-gone" } },
    });
    await flush();
    const second = session.send("two");
    await flush();
    process.turns[0]?.finish();
    await flush();
    expect(process.turns.map((turn) => turn.text)).toEqual(["one", "two"]);
    process.turns[1]?.finish();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("shows the latest message's steps", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const step = vi.fn();
    void session.send("one", { step });
    await flush();
    process.update(session.id, {
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "shell · ls",
      rawInput: { command: "ls" },
    });
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
    await flush();
    expect(step.mock.calls).toEqual([
      ["shell", "ls"],
      ["Writing reply", undefined],
    ]);
    process.turns[0]?.finish();
  });

  it("ends work that only wrote text with what goose wrote", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Network error: no provider" },
    });
    await flush();
    process.turns[0]?.finish();
    await expect(settled).resolves.toEqual({
      ok: true,
      text: "Network error: no provider",
    });
  });

  it("ends work that acted in Buzz without its closing text", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    await process.mcp(session.id, "tools/call", {
      name: "send",
      arguments: { content: "hi" },
    });
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Sent it." },
    });
    await flush();
    process.turns[0]?.finish();
    await expect(settled).resolves.toEqual({ ok: true });
  });

  it("ends work that only read or failed to send with what goose wrote", async () => {
    const failed: ToolServer = async (conversation, message) =>
      (message.params as { name?: string }).name === "send"
        ? {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "no" }], isError: true },
          }
        : ok(conversation, message);
    const { open, process } = await start(failed);
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    await process.mcp(session.id, "tools/call", { name: "read" });
    await process.mcp(session.id, "tools/call", {
      name: "send",
      arguments: { content: "hi" },
    });
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Here is the answer." },
    });
    await flush();
    process.turns[0]?.finish();
    await expect(settled).resolves.toEqual({
      ok: true,
      text: "Here is the answer.",
    });
  });

  it("keeps a pick whose steer came too late, for its own turn", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open({
      choice: () => ({ provider: "openai", model: "gpt-4.1" }),
    });
    const first = session.send("one", {}, "o3");
    await flush();
    // The turn ends before goose takes the steer.
    process.turns[0]?.finish();
    const second = session.send("two", {}, "o3");
    await flush();
    expect(process.turns.map((turn) => [turn.text, turn.steered])).toEqual([
      ["one", []],
      ["two", []],
    ]);
    expect(process.configured.at(-1)).toMatch(/ model=o3$/);
    process.turns[1]?.finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it("ends work whose turn ended while a steer into it was answered", async () => {
    const { open, process } = await start();
    process.hold = true;
    process.endOnSteer = true;
    const session = await open();
    const first = session.send("one");
    await flush();
    const second = session.send("two");
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(process.turns[0]?.steered).toEqual(["two"]);
    expect(session.busy).toBe(false);
  });

  it("allows what goose asks permission for", async () => {
    const { process } = await start();
    const response = await process.ask("session/request_permission", {
      sessionId: "s",
      options: [
        { optionId: "no", kind: "reject_once" },
        { optionId: "once", kind: "allow_once" },
        { optionId: "always", kind: "allow_always" },
      ],
    });
    expect(response.result).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
  });

  it("fails a working session with goose's last words when it exits", async () => {
    const { goose, open, process } = await start();
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    process.exit(1, "starting\nNo provider configured\n");
    await expect(settled).resolves.toEqual({
      ok: false,
      error: "No provider configured",
    });
    expect(goose.running).toBe(false);
  });

  it("stops a goose that does not answer as it starts", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn({ silent: ["initialize"] });
    const starting = GooseProcess.start(fake.spawn, { cwd: "/work" });
    const failed = expect(starting).rejects.toThrow(
      "goose did not answer initialize in 60s",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(fake.geese[0]?.killed).toBe(true);
  });

  it("stops a goose that does not open or close a session", async () => {
    vi.useFakeTimers();
    const { open, process, fake } = await start(ok, ["session/new"]);
    const opening = open();
    const failed = expect(opening).rejects.toThrow(
      "goose did not answer session/new in 60s",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(process.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(process.killed).toBe(true);
    expect(fake.servers.map((server) => server.closed)).toEqual([true]);

    const other = await start(ok, ["session/close"]);
    const session = await other.open();
    const closing = other.goose.close(session);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await closing;
    expect(other.process.killed).toBe(true);
  });

  it("gives a burst's text to its latest acknowledged message only", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const first = session.send("one", { step: () => {} });
    await flush();
    const second = session.send("two", { step: () => {} });
    await flush();
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Forgot to send" },
    });
    await flush();
    process.turns[0]?.finish();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true, text: "Forgot to send" });
  });

  it("gives a failed burst's error to one message", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const first = session.send("one", { step: () => {} });
    await flush();
    const second = session.send("two", { step: () => {} });
    await flush();
    process.exit(1, "crashed\n");
    await expect(first).resolves.toEqual({ ok: false });
    await expect(second).resolves.toEqual({ ok: false, error: "crashed" });
  });

  it("cancels the running turn when interrupted, and does nothing when idle", async () => {
    const { open, process } = await start();
    const session = await open();
    const cancels = () =>
      process.received.filter((message) => message.method === "session/cancel");
    session.interrupt();
    await flush();
    expect(cancels()).toEqual([]);
    process.hold = true;
    const settled = session.send("hello");
    await flush();
    session.interrupt();
    await flush();
    expect(cancels()).toMatchObject([{ params: { sessionId: session.id } }]);
    expect(cancels()[0]?.id).toBeUndefined();
    expect(process.cancelled).toEqual([session.id]);
    await expect(settled).resolves.toEqual({ ok: true, stopped: true });
    expect(session.busy).toBe(false);
    session.interrupt();
    await flush();
    expect(cancels()).toHaveLength(1);
  });

  it("drops the turns queued behind an interrupted one", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const first = session.send("one");
    await flush();
    // Another model cannot be steered in, so it waits as the next turn.
    const second = session.send("two", {}, "other-model");
    await flush();
    session.interrupt();
    await expect(first).resolves.toEqual({ ok: true, stopped: true });
    await expect(second).resolves.toEqual({ ok: true, stopped: true });
    await flush();
    expect(process.turns.map((turn) => turn.text)).toEqual(["one"]);
    expect(
      process.received.filter((message) => message.method === "session/prompt"),
    ).toHaveLength(1);
    expect(session.busy).toBe(false);
  });

  it("ends a stopped turn without the text goose wrote, and the next turn with its own", async () => {
    const { open, process } = await start();
    process.hold = true;
    const session = await open();
    const stopped = session.send("one");
    await flush();
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Working on it" },
    });
    await flush();
    session.interrupt();
    const result = await stopped;
    expect(result).toEqual({ ok: true, stopped: true });
    expect(result).not.toHaveProperty("text");
    // Stopping is forgotten with the work it ended.
    const next = session.send("two");
    await flush();
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Network error: no provider" },
    });
    await flush();
    process.turns[1]?.finish();
    await expect(next).resolves.toEqual({
      ok: true,
      text: "Network error: no provider",
    });
  });

  it("never sends a turn whose provider switch was still going when the owner stopped it", async () => {
    const { goose, process, release, waiting } = await slow(
      "session/set_config_option",
    );
    process.hold = true;
    const session = await goose.open({
      cwd: "/work",
      systemPrompt: "",
      choice: () => ({ provider: "openai", model: "gpt-4.1" }),
    });
    const settled = session.send("one");
    await flush();
    expect(waiting()).toBe(1);
    session.interrupt();
    await flush();
    release();
    await expect(settled).resolves.toEqual({ ok: true, stopped: true });
    expect(process.turns).toEqual([]);
    expect(
      process.received.filter((message) => message.method === "session/prompt"),
    ).toEqual([]);
    expect(session.busy).toBe(false);
  });

  it("does not run a message again whose steer failed after the owner stopped the turn", async () => {
    const { goose, process, release, waiting } = await slow(
      "_goose/unstable/session/steer",
      true,
    );
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("one");
    await flush();
    const second = session.send("two");
    await flush();
    // It was steered into the running turn, not queued behind it.
    expect(waiting()).toBe(1);
    session.interrupt();
    await flush();
    release();
    await expect(first).resolves.toEqual({ ok: true, stopped: true });
    await expect(second).resolves.toEqual({ ok: true, stopped: true });
    await flush();
    expect(process.turns.map((turn) => turn.text)).toEqual(["one"]);
    expect(
      process.received.filter((message) => message.method === "session/prompt"),
    ).toHaveLength(1);
    expect(session.busy).toBe(false);
  });

  it("does not call a turn stopped that goose ended on its own before the cancel took effect", async () => {
    const { goose, process, release } = await slow("session/cancel");
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const settled = session.send("one");
    await flush();
    session.interrupt();
    await flush();
    process.turns[0]?.finish();
    release();
    await expect(settled).resolves.toEqual({ ok: true });
    expect(session.busy).toBe(false);
  });

  it("runs a message sent while a stopped turn is ending as a turn of its own", async () => {
    const { goose, process, release } = await slow("session/cancel");
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("one");
    await flush();
    session.interrupt();
    await flush();
    // goose has not ended the stopped turn yet, so it must not be steered.
    const second = session.send("two");
    await flush();
    expect(
      process.received.filter(
        (message) => message.method === "_goose/unstable/session/steer",
      ),
    ).toEqual([]);
    release();
    await expect(first).resolves.toEqual({ ok: true, stopped: true });
    await vi.waitFor(() =>
      expect(process.turns.map((turn) => turn.text)).toEqual(["one", "two"]),
    );
    expect(session.busy).toBe(true);
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Two's answer" },
    });
    await flush();
    process.turns[1]?.finish();
    await expect(second).resolves.toEqual({ ok: true, text: "Two's answer" });
    expect(session.busy).toBe(false);
  });

  it("keeps a message queued while a stopped turn is ending for a turn of its own", async () => {
    const { goose, process, release } = await slow("session/cancel");
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("one");
    await flush();
    session.interrupt();
    await flush();
    const second = session.send("two", {}, "other-model");
    await flush();
    release();
    await expect(first).resolves.toEqual({ ok: true, stopped: true });
    await vi.waitFor(() =>
      expect(process.turns.map((turn) => turn.text)).toEqual(["one", "two"]),
    );
    process.turns[1]?.finish();
    await expect(second).resolves.toEqual({ ok: true });
    expect(session.busy).toBe(false);
  });

  it("leaves a later message's activity alone when a steer from before Stop lands after it", async () => {
    const { goose, process, release } = await slow(
      "_goose/unstable/session/steer",
    );
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("one", { step: () => {} });
    await flush();
    const steered = { step: vi.fn(), acknowledged: vi.fn() };
    const second = session.send("two", steered);
    await flush();
    session.interrupt();
    await flush();
    const later = {
      step: vi.fn(),
      acknowledged: vi.fn(),
      superseded: vi.fn(),
    };
    const third = session.send("three", later);
    await flush();
    await expect(first).resolves.toEqual({ ok: true, stopped: true });
    await expect(second).resolves.toEqual({ ok: true, stopped: true });
    await vi.waitFor(() =>
      expect(process.turns.map((turn) => turn.text)).toEqual(["one", "three"]),
    );
    release();
    await flush();
    expect(steered.acknowledged).not.toHaveBeenCalled();
    expect(later.acknowledged).toHaveBeenCalledTimes(1);
    expect(later.superseded).not.toHaveBeenCalled();
    process.turns[1]?.finish();
    await expect(third).resolves.toEqual({ ok: true });
    expect(session.busy).toBe(false);
  });

  it("cancels a session's turn when it closes", async () => {
    const { goose, open, process } = await start();
    process.hold = true;
    const session = await open();
    const settled = session.send("hello");
    await flush();
    await goose.close(session);
    expect(process.cancelled).toEqual([session.id]);
    expect(process.closed).toEqual([session.id]);
    await expect(settled).resolves.toMatchObject({ ok: false });
  });
});

describe("stepLabel", () => {
  it("names a tool call by its tool and target, as goose titles it", () => {
    expect(
      stepLabel({
        sessionUpdate: "tool_call",
        title: "shell · sleep 10",
        rawInput: { command: "sleep 10" },
      }),
    ).toEqual({ tool: "shell", target: "sleep 10" });
    expect(
      stepLabel({
        sessionUpdate: "tool_call",
        title: "buzz: send",
        rawInput: { text: "hi", path: "/a/b/notes.md" },
      }),
    ).toEqual({ tool: "send", target: "notes.md" });
  });
});

it("drops a cancelled source after provider selection without cancelling ordinary work", async () => {
  const { goose, process, release, waiting } = await slow(
    "session/set_config_option",
  );
  const session = await goose.open({
    cwd: "/work",
    systemPrompt: "",
    choice: () => ({ provider: "openai", model: "gpt-4.1" }),
  });
  let current = true;
  const cancelled = session.send("cancelled wake", { current: () => current });
  await flush();
  expect(waiting()).toBe(1);
  current = false;
  release();
  await expect(cancelled).resolves.toEqual({ ok: true, undelivered: true });
  await session.send("ordinary message");
  expect(process.turns.map((turn) => turn.text)).toEqual(["ordinary message"]);
});

it("does not steer a stopped run after an Attention prompt refresh", async () => {
  const { open, process, goose } = await start();
  process.hold = true;
  const session = await open();
  const first = session.send("one");
  await vi.waitFor(() => expect(process.turns).toHaveLength(1));
  let release!: () => void;
  let refreshing!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    refreshing = resolve;
  });
  const second = session.send("old wake", {
    current: () => true,
    refresh: async () => {
      refreshing();
      await gate;
      return "updated wake";
    },
  });
  try {
    await started;
    session.interrupt();
  } finally {
    release();
  }
  await Promise.all([first, second]);
  await session.idle();
  await flush();
  expect(
    process.received.filter(
      (message) => message.method === "_goose/unstable/session/steer",
    ),
  ).toEqual([]);
  await goose.close(session);
});

it("keeps Goose steers in order across an Attention refresh", async () => {
  const { open, process, goose } = await start();
  process.hold = true;
  const session = await open();
  const first = session.send("one");
  await vi.waitFor(() => expect(process.turns).toHaveLength(1));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const second = session.send("old wake", {
    current: () => true,
    refresh: async () => {
      ready();
      await gate;
      return "updated wake";
    },
  });
  await entered;
  const third = session.send("later mention");
  try {
    await flush();
    expect(process.turns[0]?.steered).toEqual([]);
    release();
    await vi.waitFor(() => expect(process.turns[0]?.steered).toHaveLength(2));
    expect(process.turns[0]?.steered[0]).toContain("updated wake");
    expect(process.turns[0]?.steered[1]).toBe("later mention");
  } finally {
    release();
    await flush();
    await goose.close(session);
    await Promise.all([first, second, third]);
  }
});

it.each([1, 2])(
  "keeps %s refreshing Attention steers ahead of a later queued model pick",
  async (count) => {
    const { open, process, goose } = await start();
    process.hold = true;
    const session = await open({
      choice: () => ({ provider: "openai", model: "gpt-4.1" }),
    });
    const first = session.send("first");
    await vi.waitFor(() => expect(process.turns).toHaveLength(1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const second = session.send("old wake", {
      current: () => true,
      refresh: async () => {
        ready();
        await gate;
        return "updated wake";
      },
    });
    await entered;
    const wakes = [second];
    if (count === 2) wakes.push(session.send("another wake"));
    const third = session.send("later mention", {}, "o3");
    try {
      process.turns[0]?.finish();
      await flush();
      expect(process.turns.map((turn) => turn.text)).toEqual(["first"]);
      release();
      const texts = ["updated wake", "another wake"].slice(0, count);
      for (const [index, text] of texts.entries()) {
        await vi.waitFor(() => expect(process.turns).toHaveLength(index + 2));
        expect(process.turns[index + 1]?.text).toBe(text);
        process.turns[index + 1]?.finish();
      }
      await vi.waitFor(() => expect(process.turns).toHaveLength(count + 2));
      expect(process.turns[count + 1]?.text).toBe("later mention");
      expect(process.configured.at(-1)).toMatch(/ model=o3$/);
    } finally {
      release();
      await flush();
      await goose.close(session);
      await Promise.all([first, ...wakes, third]);
    }
  },
);

it("lets new work steer while a stopped Attention refresh is still pending", async () => {
  const { open, process, goose } = await start();
  process.hold = true;
  const session = await open();
  const first = session.send("first");
  await vi.waitFor(() => expect(process.turns).toHaveLength(1));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const stopped = session.send("old wake", {
    refresh: async () => {
      ready();
      await gate;
      return "cancelled wake";
    },
  });
  await entered;
  session.interrupt();
  const next = session.send("new work");
  let later: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(process.turns).toHaveLength(2));
    expect(process.turns[1]?.text).toBe("new work");
    later = session.send("new steer");
    await vi.waitFor(() =>
      expect(process.turns[1]?.steered).toEqual(["new steer"]),
    );
    expect(process.turns[0]?.steered).toEqual([]);
  } finally {
    release();
    await flush();
    await goose.close(session);
    await Promise.all([first, stopped, next, later]);
  }
});
