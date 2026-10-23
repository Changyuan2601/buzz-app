import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import {
  createAgentToolHooks,
  hookMessageSource,
  ToolHookCallbacks,
  type AgentToolHookEvent,
} from "./tool-hooks";
const event: AgentToolHookEvent = {
  phase: "before",
  agent: "a",
  session: "s",
  callId: "c",
  tool: "Bash",
  input: {},
  context: {},
  messages: [{ id: "one", channel: "ch", deliveredAt: 1 }],
};
it("consults active plugin revisions and removes enforcement on unload", async () => {
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
  const hooks = createAgentToolHooks(root);
  const fiber = root
    .extend({ pluginOwner: { id: "policy", revision: "one" } })
    .plugin((ctx) =>
      hooks.register(ctx, { id: "gate", run: () => "Reply first" }),
    );
  await fiber.await();
  expect(await hooks.run(event)).toBe("Reply first");
  active = false;
  for (const listener of listeners) listener();
  expect(await hooks.run(event)).toBeUndefined();
  active = true;
  for (const listener of listeners) listener();
  expect(await hooks.run(event)).toBe("Reply first");
  await fiber.dispose();
  expect(await hooks.run(event)).toBeUndefined();
  await root.fiber.dispose();
});
it("retains pre-call messages when a newer mention arrives and ignores unmatched completions", async () => {
  const seen: AgentToolHookEvent[] = [];
  const callbacks = new ToolHookCallbacks(async (event) => {
    seen.push(event);
    return undefined;
  });
  await callbacks.before(event);
  const next = {
    ...event,
    callId: "new",
    messages: [...event.messages, { id: "two", channel: "ch", deliveredAt: 2 }],
  };
  await callbacks.before(next);
  await callbacks.after("c", true);
  await callbacks.after("missing", true);
  await callbacks.after("new", false);
  expect(
    seen
      .filter((event) => event.phase === "after")
      .map(({ messages, success }) => [messages.map(({ id }) => id), success]),
  ).toEqual([
    [["one"], true],
    [["one", "two"], false],
  ]);
});
it("does not record a denied call as an executable tool", async () => {
  const run = vi.fn(async () => "denied");
  const callbacks = new ToolHookCallbacks(run);
  expect(await callbacks.before(event)).toBe("denied");
  await callbacks.after("c", true);
  expect(run).toHaveBeenCalledOnce();
});

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
