import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { createAgentHooks } from "./hooks";

it("requires declared access and resolves active callbacks on every event", async () => {
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
  const registry = createAgentHooks(root);
  const run = vi.fn();
  expect(() =>
    registry.register(root, {
      id: "x",
      harness: "third/type",
      event: "before",
      run,
    }),
  ).toThrow("Declare host.agentHooks");
  const fiber = root
    .extend({
      pluginOwner: { id: "policy", revision: "1", agentHooks: ["third/type"] },
    })
    .plugin((ctx) => {
      registry.register(ctx, {
        id: "b",
        harness: "third/type",
        event: "before",
        run,
      });
      registry.register(ctx, {
        id: "a",
        harness: "third/type",
        event: "before",
        run,
      });
      expect(() =>
        registry.register(ctx, {
          id: "other",
          harness: "fourth/type",
          event: "before",
          run,
        }),
      ).toThrow("Declare host.agentHooks");
    });
  await fiber.await();
  expect(registry.handlers("third/type", "before").map(({ id }) => id)).toEqual(
    ["a", "b"],
  );
  expect(registry.handlers("third/type", "after")).toEqual([]);
  active = false;
  for (const listener of listeners) listener();
  expect(registry.handlers("third/type", "before")).toEqual([]);
  active = true;
  for (const listener of listeners) listener();
  expect(registry.handlers("third/type", "before")).toHaveLength(2);
  await fiber.dispose();
  expect(registry.handlers("third/type", "before")).toEqual([]);
  await root.fiber.dispose();
});
