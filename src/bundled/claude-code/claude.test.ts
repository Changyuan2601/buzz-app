import { expect, it, vi } from "vitest";
import { ClaudeProcess } from "./claude";
import { fakeSpawn, flush } from "./claude-testing";

const launch = {
  cwd: "~/.buzz",
  systemPrompt: "<base>be useful</base>",
};

it("starts Claude as the SDK does and initializes it with the system prompt", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    model: "opus",
    sessionId: "new-session",
  });
  const [fake] = processes;
  expect(fake?.options.args).toEqual([
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "opus",
    "--session-id",
    "new-session",
  ]);
  expect(fake?.options).toMatchObject({
    cwd: "~/.buzz",
    env: {
      CLAUDECODE: null,
      CLAUDE_CODE_SESSION_ID: null,
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    },
  });
  expect(fake?.received[0]).toMatchObject({
    type: "control_request",
    request: { subtype: "initialize", appendSystemPrompt: launch.systemPrompt },
  });
  expect(claude.sessionId).toBe("new-session");
  expect(claude.started).toBe(false);
});

it("resolves a message once the session is idle, and keeps the process for the next", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  await expect(claude.send("hello")).resolves.toEqual({ ok: true });
  expect(claude.started).toBe(true);
  expect(claude.busy).toBe(false);
  await expect(claude.send("again")).resolves.toEqual({ ok: true });
  expect(processes).toHaveLength(1);
  expect(processes[0]?.prompts).toEqual(["hello", "again"]);
});

it("answers both messages of a turn that took a second one mid-way", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const first = claude.send("first");
  const second = claude.send("second");
  expect(claude.busy).toBe(true);
  let done = false;
  void first.then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  fake.finish();
  await expect(first).resolves.toEqual({ ok: true });
  await expect(second).resolves.toEqual({ ok: true });
});

it("runs a turn at the effort asked for, and the next without one at the session's own", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  await claude.send("plain");
  expect(fake.received.map((message) => message.type)).toEqual([
    "control_request",
    "user",
  ]);
  await claude.send("hard", { effort: "xhigh" });
  fake.hold = true;
  const quick = claude.send("quick", { effort: "low" });
  // Folded into the running turn, a message without an effort keeps it.
  const steer = claude.send("also");
  await flush();
  fake.finish();
  await Promise.all([quick, steer]);
  fake.hold = false;
  await claude.send("after");
  expect(fake.prompts).toEqual(["plain", "hard", "quick", "also", "after"]);
  expect(fake.efforts).toEqual(["high", "xhigh", "low", "low", "high"]);
  // The session's own level is read once, before the first change.
  expect(
    fake.received.filter(
      (message) =>
        (message.request as { subtype?: string } | undefined)?.subtype ===
        "get_settings",
    ),
  ).toHaveLength(1);
});

it("runs a turn on the model asked for, and the next without one on the session's own", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    model: "opus",
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  await expect(claude.models()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ value: "haiku" })]),
  );
  await claude.send("plain");
  fake.hold = true;
  const quick = claude.send("quick", { model: "haiku" });
  // Folded into the running turn, a message without a model keeps it.
  const steer = claude.send("also");
  await flush();
  fake.finish();
  await Promise.all([quick, steer]);
  fake.hold = false;
  await claude.send("after");
  expect(fake.models).toEqual(["opus", "haiku", "haiku", "opus"]);
  // The session reports its own model, not the picked one.
  await expect(claude.readModel()).resolves.toBe("claude-opus-5-5");
  expect(
    fake.received
      .map((message) => message.request as { subtype?: string; model?: string })
      .filter((request) => request?.subtype === "set_model")
      .map((request) => request.model),
  ).toEqual(["haiku", "opus"]);
});

it("settles on each result when Claude does not report idle", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(
    (id, options) => spawn(id, { ...options, env: {} }),
    { ...launch, sessionId: "s1" },
  );
  expect(processes[0]?.options.env).toEqual({});
  await expect(claude.send("hello")).resolves.toEqual({ ok: true });
  expect(claude.busy).toBe(false);
});

it("reports a turn that ends in an error with Claude's own words", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
  });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.hold = true;
  const sent = claude.send("hello");
  await flush();
  fake.finish({ error: "Credit balance is too low" });
  await expect(sent).resolves.toEqual({
    ok: false,
    error: "Credit balance is too low",
  });
});

it("fails what is waiting when the process exits, with its last stderr line", async () => {
  const { spawn } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    resume: "gone",
  });
  expect(claude.sessionId).toBe("gone");
  await expect(claude.send("hello")).resolves.toEqual({
    ok: false,
    error: "No conversation found with session ID: gone",
  });
  expect(claude.running).toBe(false);
  expect(claude.started).toBe(false);
  await expect(claude.send("more")).resolves.toMatchObject({ ok: false });
});

it("allows tool use and acknowledges hooks it is asked about", async () => {
  const { spawn, processes } = fakeSpawn();
  await ClaudeProcess.start(spawn, { ...launch, sessionId: "s1" });
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  fake.emit({
    type: "control_request",
    request_id: "r1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
    },
  });
  fake.emit({
    type: "control_request",
    request_id: "r2",
    request: { subtype: "hook_callback", callback_id: "h" },
  });
  fake.emit({
    type: "control_request",
    request_id: "r3",
    request: { subtype: "mcp_message" },
  });
  await flush();
  const responses = fake.received
    .filter((message) => message.type === "control_response")
    .map((message) => message.response);
  expect(responses).toEqual([
    {
      subtype: "success",
      request_id: "r1",
      response: { behavior: "allow", updatedInput: { command: "ls" } },
    },
    { subtype: "success", request_id: "r2", response: {} },
    {
      subtype: "error",
      request_id: "r3",
      error: "Buzz does not handle mcp_message",
    },
  ]);
});

it("serves the Buzz tools over the pipe and ends a turn on a final send", async () => {
  const { spawn, processes } = fakeSpawn();
  const tools = vi.fn(async (_conversation: unknown, message: unknown) => ({
    jsonrpc: "2.0",
    id: (message as { id: number }).id,
    result: { content: [{ type: "text", text: "sent" }] },
  }));
  const claude = await ClaudeProcess.start(spawn, {
    ...launch,
    sessionId: "s1",
    tools,
  });
  claude.conversation = "chan/root";
  const fake = processes[0];
  if (!fake) throw new Error("no process");
  const config =
    fake.options.args?.[fake.options.args.indexOf("--mcp-config") + 1];
  expect(JSON.parse(config ?? "{}")).toEqual({
    mcpServers: { buzz: { type: "sdk", name: "buzz", alwaysLoad: true } },
  });
  expect(fake.received[0]).toMatchObject({
    request: {
      sdkMcpServers: ["buzz"],
      hooks: {
        PostToolUse: [
          { matcher: "mcp__buzz__send", hookCallbackIds: ["final"] },
        ],
      },
    },
  });
  fake.hold = true;
  void claude.send("hi");
  const call = { jsonrpc: "2.0", id: 3, method: "tools/call" };
  fake.emit({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "mcp_message", server_name: "buzz", message: call },
  });
  const hook = (final: boolean) => ({
    type: "control_request",
    request_id: `final-${final}`,
    request: {
      subtype: "hook_callback",
      callback_id: "final",
      input: {
        tool_name: "mcp__buzz__send",
        tool_input: { text: "done", final },
        tool_response: [{ type: "text", text: "sent" }],
      },
    },
  });
  fake.emit(hook(false));
  fake.emit(hook(true));
  await flush();
  expect(tools).toHaveBeenCalledWith("chan/root", call);
  const responses = fake.received
    .filter((message) => message.type === "control_response")
    .map((message) => message.response);
  expect(responses).toEqual([
    { subtype: "success", request_id: "final-false", response: {} },
    {
      subtype: "success",
      request_id: "final-true",
      response: { continue: false },
    },
    {
      subtype: "success",
      request_id: "r1",
      response: {
        mcp_response: {
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "sent" }] },
        },
      },
    },
  ]);
});

it("reads messages split across output chunks", async () => {
  let stdout: ((data: string) => void) | undefined;
  const claude = await ClaudeProcess.start(
    async (_id, options) => {
      stdout = options?.onStdout;
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise(() => undefined),
      };
    },
    { ...launch, sessionId: "s1" },
  );
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "s2",
  });
  stdout?.(line.slice(0, 10));
  expect(claude.started).toBe(false);
  stdout?.(`${line.slice(10)}\n`);
  expect(claude.started).toBe(true);
  expect(claude.sessionId).toBe("s2");
});
