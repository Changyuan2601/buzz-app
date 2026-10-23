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
