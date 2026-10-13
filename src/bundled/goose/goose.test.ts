import { describe, expect, it, vi } from "vitest";
import { GooseProcess, stepLabel, type ToolServer } from "./goose";
import { fakeSpawn, flush } from "./goose-testing";

const ok: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: { content: [{ type: "text", text: "done" }] },
});

const start = async (tools: ToolServer = ok, acp = true) => {
  const fake = fakeSpawn({ acp });
  const goose = await GooseProcess.start(fake.spawn, {
    cwd: "/work",
    env: { GOOSE_MODEL: "m" },
    tools,
  });
  const [process] = fake.geese;
  if (!process) throw new Error("goose did not start");
  return { goose, process, fake };
};

describe("GooseProcess", () => {
  it("starts goose-acp without the app's Buzz identity", async () => {
    const { process } = await start();
    expect(process.options.cwd).toBe("/work");
    expect(process.options.env).toMatchObject({
      GOOSE_MODE: "auto",
      GOOSE_DISABLE_SESSION_NAMING: "true",
      GOOSE_MODEL: "m",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
      BUZZ_RELAY_URL: null,
    });
  });

  it("refuses a goose that cannot serve the Buzz tools", async () => {
    const fake = fakeSpawn({ acp: false });
    await expect(
      GooseProcess.start(fake.spawn, { cwd: "/work", tools: ok }),
    ).rejects.toThrow(/MCP-over-ACP/);
    expect(fake.geese[0]?.killed).toBe(true);
  });

  it("opens a session with the Buzz tools and its system prompt", async () => {
    const { goose, process } = await start();
    const session = await goose.open({ cwd: "/work", systemPrompt: "Be Buzz" });
    const buzz = { type: "acp", name: "buzz", serverId: "buzz" };
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

  it("settles a message when its turn ends", async () => {
    const { goose, process } = await start();
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    await expect(session.send("hello")).resolves.toEqual({ ok: true });
    expect(process.turns.map((turn) => turn.text)).toEqual(["hello"]);
    expect(session.busy).toBe(false);
  });

  it("answers the Buzz tools' MCP messages for the session's conversation", async () => {
    const tools = vi.fn(ok);
    const { goose, process } = await start(tools);
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    session.conversation = "channel/root";
    const response = await process.mcp(session.id, "tools/list");
    expect(tools).toHaveBeenCalledWith("channel/root", {
      id: expect.any(String),
      method: "tools/list",
      params: {},
    });
    expect(response.result).toEqual({
      result: { content: [{ type: "text", text: "done" }] },
    });
  });

  it("returns a tool server's failure as the MCP error", async () => {
    const { goose, process } = await start(async () => {
      throw new Error("relay down");
    });
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const response = await process.mcp(session.id, "tools/call", {
      name: "send",
      arguments: {},
    });
    expect(response.result).toEqual({
      error: { code: -32603, message: "relay down" },
    });
  });

  it("counts the work done when a final send succeeds", async () => {
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const settled = session.send("hello");
    await flush();
    await process.mcp(session.id, "tools/call", {
      name: "send",
      arguments: { content: "hi", final: true },
    });
    await expect(settled).resolves.toEqual({ ok: true });
    expect(session.busy).toBe(false);
    process.turns[0]?.finish();
  });

  it("steers a message that arrives mid-turn into it", async () => {
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
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
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
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

  it("names a session with its title", async () => {
    const { goose, process } = await start();
    await goose.open({
      cwd: "/work",
      systemPrompt: "",
      title: "Ada · #general",
    });
    expect(process.opened[0]?._meta).toMatchObject({
      sessionTitle: "Ada · #general",
    });
  });

  it("runs a message the turn could not take as the next turn", async () => {
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
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
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
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

  it("fails work that only wrote text, with what goose wrote", async () => {
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const settled = session.send("hello");
    await flush();
    process.update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Network error: no provider" },
    });
    await flush();
    process.turns[0]?.finish();
    await expect(settled).resolves.toEqual({
      ok: false,
      error: "Network error: no provider",
    });
  });

  it("ends work that acted in Buzz without its closing text", async () => {
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
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
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
    const settled = session.send("hello");
    await flush();
    process.exit(1, "starting\nNo provider configured\n");
    await expect(settled).resolves.toEqual({
      ok: false,
      error: "No provider configured",
    });
    expect(goose.running).toBe(false);
  });

  it("cancels a session's turn when it closes", async () => {
    const { goose, process } = await start();
    process.hold = true;
    const session = await goose.open({ cwd: "/work", systemPrompt: "" });
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
