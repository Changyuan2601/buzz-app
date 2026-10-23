import { expect, it, vi } from "vitest";
import type { AppServer } from "./rpc";
import { CodexHooks, hookToolName } from "./hooks";
it("exposes evaluation but no forged completion, and trusts only its own current hook hash", async () => {
  let handler!: (message: unknown) => Promise<unknown>;
  const close = vi.fn(async () => {});
  const before = vi.fn(async () => "Reply first");
  const hooks = new CodexHooks(async (run) => {
    handler = run;
    return {
      url: "http://127.0.0.1:123/mcp",
      headers: [{ name: "Authorization", value: "Bearer fixture" }],
      close,
      closed: new Promise(() => {}),
    };
  }, before);
  expect(await hooks.open()).toEqual([
    "-c",
    expect.stringContaining("hooks.PreToolUse="),
  ]);
  const own = {
    key: "own",
    currentHash: "hash",
    source: "sessionFlags",
    server: "buzz_tool_hooks",
    tool: "before_tool",
    eventName: "preToolUse",
  };
  const request = vi.fn(async () => ({
    data: [{ hooks: [own, { ...own, key: "user", source: "user" }] }],
  }));
  const rpc = { request } as unknown as AppServer;
  expect((await hooks.config(rpc, "/workspace")).state).toEqual({
    own: { enabled: true, trusted_hash: "hash" },
  });
  const list = (await handler({ id: 1, method: "tools/list" })) as {
    result: { tools: { name: string }[] };
  };
  expect(list.result.tools.map((tool) => tool.name)).toEqual(["before_tool"]);
  const reply = (await handler({
    id: 2,
    method: "tools/call",
    params: { name: "before_tool", arguments: { session_id: "s" } },
  })) as { result: { content: { text: string }[] } };
  expect(JSON.parse(reply.result.content[0]?.text ?? "")).toEqual({
    decision: "block",
    reason: "Reply first",
  });
  request.mockResolvedValue({ data: [{ hooks: [] }] });
  await expect(hooks.config(rpc, "/workspace")).rejects.toThrow(
    "did not register",
  );
  await hooks.close();
  expect(close).toHaveBeenCalledOnce();
});

it("normalizes native dynamic-tool names for plugin policies", () => {
  expect(hookToolName("buzzsend")).toBe("mcp__buzz__send");
  expect(hookToolName("buzzread")).toBe("mcp__buzz__read");
  expect(hookToolName("Bash")).toBe("Bash");
});

it("gives concurrent and resumed threads separate transports and releases each independently", async () => {
  const servers: { url: string; close: ReturnType<typeof vi.fn> }[] = [];
  const hooks = new CodexHooks(
    async () => {
      const server = {
        url: `http://127.0.0.1:${1234 + servers.length}/mcp`,
        headers: [],
        close: vi.fn(async () => {}),
        closed: new Promise<void>(() => {}),
      };
      servers.push(server);
      return server;
    },
    async () => undefined,
  );
  const rpc = {
    request: async () => ({
      data: [
        {
          hooks: [
            {
              key: "own",
              currentHash: "hash",
              source: "sessionFlags",
              server: "buzz_tool_hooks",
              tool: "before_tool",
              eventName: "preToolUse",
            },
          ],
        },
      ],
    }),
  } as unknown as AppServer;
  await hooks.open();
  const first = await hooks.config(rpc, "/workspace");
  const second = await hooks.config(rpc, "/workspace");
  expect(first.server.url).not.toBe(second.server.url);
  await first.close();
  expect(servers[0]?.close).toHaveBeenCalledOnce();
  expect(servers[1]?.close).not.toHaveBeenCalled();
  const resumed = await hooks.config(rpc, "/workspace");
  expect(resumed.server.url).not.toBe(first.server.url);
  await hooks.close();
  for (const server of servers) expect(server.close).toHaveBeenCalledOnce();
});

it("closes a transport whose allocation finishes after process shutdown", async () => {
  let resolve!: (server: {
    url: string;
    headers: never[];
    close: ReturnType<typeof vi.fn>;
    closed: Promise<void>;
  }) => void;
  const serve = vi.fn(
    () =>
      new Promise<Parameters<typeof resolve>[0]>((done) => {
        resolve = done;
      }),
  );
  const hooks = new CodexHooks(serve, async () => undefined);
  const rpc = {
    request: async () => ({
      data: [
        {
          hooks: [
            {
              key: "own",
              currentHash: "hash",
              source: "sessionFlags",
              server: "buzz_tool_hooks",
              tool: "before_tool",
              eventName: "preToolUse",
            },
          ],
        },
      ],
    }),
  } as unknown as AppServer;
  const preparing = hooks.config(rpc, "/workspace");
  await vi.waitFor(() => expect(serve).toHaveBeenCalledOnce());
  await hooks.close();
  const close = vi.fn(async () => {});
  resolve({
    url: "http://127.0.0.1:123/mcp",
    headers: [],
    close,
    closed: new Promise(() => {}),
  });
  await expect(preparing).rejects.toThrow("was closed");
  expect(close).toHaveBeenCalledOnce();
});
