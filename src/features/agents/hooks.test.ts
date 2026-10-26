import { expect, it } from "vitest";
import { hookMessageSource } from "./hooks";
it("exposes sender and audience facts without imposing a reply policy", () => {
  const message = {
    id: "m",
    kind: 9,
    pubkey: "a",
    content: "hi",
    tags: [],
    created_at: 1,
  };
  const profile = {
    ...message,
    kind: 0,
    content: JSON.stringify({ is_agent: true }),
  };
  expect(hookMessageSource(message, profile)).toEqual({
    authorIsAgent: true,
    audience: "everyone",
  });
  expect(
    hookMessageSource({ ...message, tags: [["audience", "agents"]] }),
  ).toEqual({ authorIsAgent: false, audience: "agents" });
  expect(hookMessageSource(message)).toEqual({
    authorIsAgent: false,
    audience: "everyone",
  });
});

it("routes arbitrary native callbacks only to active matching registrations", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { createAgentHooks } = await import("./hooks");
  const root = new Context();
  let active = true;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  const hooks = createAgentHooks(root);
  const input = { new_upstream_field: { nested: 42 } };
  const event = {
    harness: "claude-code" as const,
    event: "FutureEvent",
    source: "harness" as const,
    input,
    agent: "a",
    session: "s",
    messages: [],
    context: {},
  };
  const fiber = root
    .extend({ pluginOwner: { id: "plugin", revision: "one" } })
    .plugin((ctx) =>
      hooks.register(ctx, {
        id: "callback",
        harness: "claude-code",
        event: "FutureEvent",
        run: (value) => ({ native_response: value.input }),
      }),
    );
  await fiber.await();
  expect(await hooks.run("plugin/callback", event)).toEqual({
    native_response: input,
  });
  expect(
    await hooks.run("plugin/callback", { ...event, event: "OtherEvent" }),
  ).toEqual({});
  active = false;
  for (const fn of listeners) fn();
  expect(await hooks.run("plugin/callback", event)).toEqual({});
  await fiber.dispose();
  await root.fiber.dispose();
});
