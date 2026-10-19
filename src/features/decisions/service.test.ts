import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import {
  DECISION_BACKEND_KEY,
  DecisionsService,
  type DecisionProvider,
  type DecisionProviderStatus,
  type DecisionRequest,
} from "./service";

const request: DecisionRequest = {
  state: "The build is broken on main.",
  questions: {
    urgent: { type: "yes_no", instructions: "It needs attention now." },
  },
};
const reply = {
  outcome: "answered" as const,
  model: "jev-1.13.0",
  answers: { urgent: { type: "yes_no" as const, probability: 0.8 } },
};
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
/** A root whose plugins are all active, and its decisions service. */
function setup(storage: Storage = memory(), active = () => true) {
  const root = new Context();
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const timers: { run(): void; ms: number }[] = [];
  const service = new DecisionsService(root, storage, (run, ms) => {
    const timer = { run, ms };
    timers.push(timer);
    return () => void timers.splice(timers.indexOf(timer), 1);
  });
  /** Registers `provider` from a plugin `id`; resolves to its fiber. */
  const plugin = async (id: string, provider: Partial<DecisionProvider>) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.decisions.registerProvider(fake(provider)));
    await fiber.await();
    await flush();
    return fiber;
  };
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return { root, service, plugin, timers, changed };
}
function fake(provider: Partial<DecisionProvider>): DecisionProvider {
  return {
    id: "main",
    label: "Fake",
    description: "A test provider.",
    status: () => "ready",
    subscribe: () => () => {},
    decide: async () => reply,
    ...provider,
  };
}
/** A provider whose status the test sets. */
function settable(status: DecisionProviderStatus) {
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: DecisionProviderStatus) {
      status = next;
      for (const listener of listeners) listener();
    },
  };
}

it("is unavailable with no provider, and never rejects", async () => {
  const { service } = setup();
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  await expect(service.decide(request)).resolves.toEqual({
    outcome: "failed",
    backend: undefined,
    reason: "unavailable",
  });
});

it("asks the provider plugins register, through the injected ctx.decisions", async () => {
  const { service, plugin } = setup();
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  const fiber = await plugin("buzz.typesafe", { id: "typesafe", decide });
  expect(service.providers().map((provider) => provider.key)).toEqual([
    "buzz.typesafe/typesafe",
  ]);
  expect(service.backend()).toBe("buzz.typesafe/typesafe");
  await expect(service.decide(request)).resolves.toEqual({
    ...reply,
    backend: "buzz.typesafe/typesafe",
  });
  // The deadline is filled in, and the provider is told when to stop.
  expect(decide).toHaveBeenCalledWith(
    { ...request, timeoutMs: 30_000 },
    { signal: expect.any(AbortSignal) },
  );
  // Disabling the plugin removes its provider.
  await fiber.dispose();
  expect(service.providers()).toEqual([]);
  expect(service.status()).toBe("unavailable");
});

it("lists only providers of active plugin revisions", async () => {
  let active = false;
  const { service, plugin, changed } = setup(memory(), () => active);
  await plugin("buzz.typesafe", {});
  expect(service.providers()).toEqual([]);
  active = true;
  changed();
  expect(service.providers()).toHaveLength(1);
});

it("prefers the user's choice, then a ready provider, then the first", async () => {
  const storage = memory();
  const { service, plugin } = setup(storage);
  const first = settable("needs-setup");
  const second = settable("needs-setup");
  await plugin("a", { ...first, order: 0 });
  await plugin("b", { ...second, order: 1 });
  expect(service.backend()).toBe("a/main");
  const listener = vi.fn();
  // Unbound, as React's useSyncExternalStore calls it.
  const { subscribe } = service;
  subscribe(listener);
  second.set("ready");
  expect(service.backend()).toBe("b/main");
  expect(service.status()).toBe("ready");
  expect(listener).toHaveBeenCalled();
  service.setBackend("a/main");
  expect(service.backend()).toBe("a/main");
  expect(storage.values.get(DECISION_BACKEND_KEY)).toBe("a/main");
  // A choice that is not a registered provider changes nothing.
  listener.mockClear();
  service.setBackend("other/main");
  expect(service.backend()).toBe("a/main");
  expect(listener).not.toHaveBeenCalled();
});

it("restores a saved choice once its provider registers, and survives unreadable storage", async () => {
  const { service, plugin } = setup(
    memory({ [DECISION_BACKEND_KEY]: "b/main" }),
  );
  await plugin("a", { order: 0 });
  // Not registered yet, so another provider answers.
  expect(service.backend()).toBe("a/main");
  await plugin("b", { order: 1, status: () => "needs-setup" });
  expect(service.backend()).toBe("b/main");
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  const other = setup(broken);
  await other.plugin("a", {});
  await other.plugin("b", { order: 1 });
  other.service.setBackend("b/main");
  expect(other.service.backend()).toBe("b/main");
});

it("checks requests before any provider sees them", async () => {
  const { service, plugin } = setup();
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  await plugin("a", { decide });
  for (const bad of [
    { ...request, state: " " },
    { ...request, questions: {} },
    {
      ...request,
      questions: { pick: { type: "choice", instructions: "x", options: {} } },
    },
    {
      ...request,
      questions: { rate: { type: "score", instructions: "x", levels: ["a"] } },
    },
    { ...request, questions: { ["x".repeat(65)]: request.questions.urgent } },
  ] as DecisionRequest[])
    await expect(service.decide(bad)).resolves.toMatchObject({
      reason: "invalid_request",
    });
  await expect(
    service.decide({ ...request, state: "x".repeat(128 * 1024) }),
  ).resolves.toMatchObject({ reason: "input_limit" });
  expect(decide).not.toHaveBeenCalled();
});

it("checks answers against the questions", async () => {
  const questions: DecisionRequest["questions"] = {
    urgent: { type: "yes_no", instructions: "Urgent." },
    pick: {
      type: "choice",
      instructions: "Which.",
      options: { a: "A", b: "B" },
    },
    rate: { type: "score", instructions: "How.", levels: ["low", "high"] },
  };
  const good = {
    urgent: { type: "yes_no", probability: 1 },
    pick: {
      type: "choice",
      choice: "b",
      confidence: 0.5,
      probabilities: { a: 0.5, b: 0.5 },
    },
    rate: { type: "score", score: 0.5, confidence: 0.9 },
    extra: { type: "yes_no", probability: 0.1 },
  };
  let answers: unknown = good;
  const { service, plugin } = setup();
  await plugin("a", {
    decide: async () => ({ outcome: "answered", model: "m", answers }) as never,
  });
  const result = await service.decide({ ...request, questions });
  expect(result).toEqual({
    outcome: "answered",
    backend: "a/main",
    model: "m",
    answers: {
      urgent: good.urgent,
      pick: good.pick,
      // Missing probabilities are none; answers not asked for are dropped.
      rate: { ...good.rate, probabilities: {} },
    },
  });
  for (const bad of [
    { ...good, urgent: { type: "yes_no", probability: 2 } },
    { ...good, urgent: { type: "choice", choice: "a", confidence: 1 } },
    { ...good, pick: { ...good.pick, choice: "toString" } },
    { ...good, pick: { ...good.pick, probabilities: { c: 0.1 } } },
    { ...good, rate: { ...good.rate, score: 2 } },
    { ...good, rate: { ...good.rate, probabilities: { "01": 0.1 } } },
    Object.assign(Object.create({ urgent: good.urgent }), {
      pick: good.pick,
      rate: good.rate,
    }),
    null,
  ]) {
    answers = bad;
    await expect(
      service.decide({ ...request, questions }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "invalid_response" });
  }
});

it("turns provider failures, throws and wrong replies into failures", async () => {
  let decide: DecisionProvider["decide"] = async () => {
    throw new Error("down");
  };
  const { service, plugin } = setup();
  await plugin("a", { decide: (...args) => decide(...args) });
  const failed = (reason: string) => ({
    outcome: "failed",
    backend: "a/main",
    reason,
  });
  await expect(service.decide(request)).resolves.toEqual(
    failed("service_error"),
  );
  for (const [odd, reason] of [
    [{ outcome: "failed", reason: "unauthorized" }, "unauthorized"],
    [{ outcome: "failed", reason: "other" }, "invalid_response"],
    [{ outcome: "answered", answers: reply.answers }, "invalid_response"],
    [null, "invalid_response"],
  ] as const) {
    decide = async () => odd as never;
    await expect(service.decide(request)).resolves.toEqual(failed(reason));
  }
});

it("stops waiting at the deadline and aborts the provider", async () => {
  const { service, plugin, timers } = setup();
  let signal: AbortSignal | undefined;
  await plugin("a", {
    decide: (_request, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const result = service.decide({ ...request, timeoutMs: 5 });
  await flush();
  // Held to at least a second.
  expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
  timers[0]?.run();
  await expect(result).resolves.toEqual({
    outcome: "failed",
    backend: "a/main",
    reason: "timeout",
  });
  expect(signal?.aborted).toBe(true);
  expect(timers).toEqual([]);
});
