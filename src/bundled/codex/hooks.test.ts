import { expect, it, vi } from "vitest";
import type { Host } from "../../features/host/service";
import type { AppServer } from "./rpc";
import type { RegisteredAgentHook } from "../../features/agents/hooks";
import { CodexHooks } from "./hooks";
const callback: RegisteredAgentHook = {
  id: "future",
  key: "plugin/future",
  pluginId: "plugin",
  revision: "one",
  harness: "codex",
  event: "FutureEvent",
  input: { novel_field: `\${novel_field}` },
  run: () => ({}),
};
function fixture() {
  const handlers: Parameters<NonNullable<Host["serveMcp"]>>[0][] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  const run = vi.fn(async () => ({ custom_native_output: { value: 42 } }));
  const hooks = new CodexHooks(
    async (handler) => {
      handlers.push(handler);
      const close = vi.fn(async () => {});
      closes.push(close);
      return {
        url: `http://localhost/${handlers.length}`,
        headers: [],
        close,
        closed: new Promise<void>(() => {}),
      };
    },
    run,
    { Stop: [{ hooks: [{ type: "command", command: "voice stop" }] }] },
    [callback],
  );
  const rpc = {
    request: vi.fn(async () => ({
      data: [
        {
          hooks: [
            {
              key: "callback",
              currentHash: "cb",
              source: "sessionFlags",
              server: "buzz_hooks",
              tool: "callback_0",
              eventName: "futureEvent",
            },
            {
              key: "native",
              currentHash: "native",
              source: "sessionFlags",
              eventName: "stop",
            },
            {
              key: "user",
              currentHash: "user",
              source: "user",
              eventName: "stop",
            },
          ],
        },
      ],
    })),
  } as unknown as AppServer;
  return { hooks, rpc, handlers, closes, run };
}
it("preserves arbitrary native events, input templates and callback output", async () => {
  const f = fixture();
  expect(await f.hooks.open()).toContainEqual(
    expect.stringContaining("hooks.FutureEvent="),
  );
  const config = await f.hooks.config(f.rpc, "/work");
  expect(config.state).toEqual({
    callback: { enabled: true, trusted_hash: "cb" },
    native: { enabled: true, trusted_hash: "native" },
  });
  const result = await f.handlers[0]?.({
    id: 1,
    method: "tools/call",
    params: {
      name: "callback_0",
      arguments: { novel_field: { nested: true } },
    },
  });
  expect(f.run).toHaveBeenCalledWith(
    "plugin/future",
    { novel_field: { nested: true } },
    undefined,
  );
  expect(result).toMatchObject({
    result: {
      content: [
        { text: JSON.stringify({ custom_native_output: { value: 42 } }) },
      ],
    },
  });
  await config.close();
  await f.hooks.close();
});
it("disables contributed hooks in title config without changing saved user trust", async () => {
  const f = fixture();
  const config = await f.hooks.config(f.rpc, "/work", false);
  expect(config.state).toEqual({
    callback: { enabled: false, trusted_hash: "cb" },
    native: { enabled: false, trusted_hash: "native" },
  });
  await f.hooks.close();
});
it("isolates thread transports and closes each independently", async () => {
  const f = fixture();
  const first = await f.hooks.config(f.rpc, "/work");
  const second = await f.hooks.config(f.rpc, "/work");
  expect(first.server.url).not.toBe(second.server.url);
  expect(f.hooks.busy).toBe(true);
  await first.close();
  expect(f.closes[0]).toHaveBeenCalledOnce();
  expect(f.closes[1]).not.toHaveBeenCalled();
  await second.close();
  expect(f.hooks.busy).toBe(false);
  await f.hooks.close();
});
it("rejects a binary that omits a configured callback", async () => {
  const f = fixture();
  vi.mocked(f.rpc.request).mockResolvedValue({ data: [{ hooks: [] }] });
  await expect(f.hooks.config(f.rpc, "/work")).rejects.toThrow(
    "native callbacks",
  );
});
