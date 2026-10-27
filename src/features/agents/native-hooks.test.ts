import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { createAgentNativeHooks } from "./native-hooks";

it("merges arbitrary native events by harness and removes disabled or unloaded contributions", async () => {
  const root = new Context();
  let active = true;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const registry = createAgentNativeHooks(root);
  const entries = [{ hooks: [{ type: "future", arbitrary: { field: 42 } }] }];
  const fiber = root
    .extend({ pluginOwner: { id: "voice", revision: "one" } })
    .plugin((ctx) => {
      registry.register(ctx, {
        id: "b",
        harness: "claude-code",
        hooks: { FutureEvent: entries },
      });
      registry.register(ctx, {
        id: "a",
        harness: "claude-code",
        hooks: { FutureEvent: [{ matcher: "first" }] },
      });
      registry.register(ctx, {
        id: "codex",
        harness: "codex",
        hooks: { Stop: [] },
      });
    });
  await fiber.await();
  entries.length = 0;
  expect(registry.config("claude-code")).toEqual({
    FutureEvent: [
      { matcher: "first" },
      { hooks: [{ type: "future", arbitrary: { field: 42 } }] },
    ],
  });
  expect(registry.config("codex")).toEqual({ Stop: [] });
  active = false;
  for (const listener of listeners) listener();
  expect(registry.config("claude-code")).toEqual({});
  active = true;
  for (const listener of listeners) listener();
  await fiber.dispose();
  expect(registry.config("claude-code")).toEqual({});
  await root.fiber.dispose();
});

it("rejects malformed event tables without interpreting hook names or entries", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createAgentNativeHooks(root);
  expect(() =>
    registry.register(root, {
      id: "bad",
      harness: "codex",
      hooks: { Stop: {} } as never,
    }),
  ).toThrow("event names to arrays");
  await root.fiber.dispose();
});

it.each([null, { matcher: null }, { matcher: [null] }, NaN, Infinity])(
  "rejects non-TOML Codex entries at registration: %j",
  async (entry) => {
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const registry = createAgentNativeHooks(root);
    const plugin = root.extend({
      pluginOwner: { id: "hooks", revision: "one" },
    });
    expect(() =>
      registry.register(plugin, {
        id: "bad",
        harness: "codex",
        hooks: { Stop: [entry] },
      }),
    ).toThrow("null TOML values");
    expect(registry.config("codex")).toEqual({});
    registry.register(plugin, {
      id: "claude",
      harness: "claude-code",
      hooks: { Stop: [entry] },
    });
    expect(registry.config("claude-code")).toEqual({
      Stop: [JSON.parse(JSON.stringify(entry))],
    });
    await root.fiber.dispose();
  },
);
