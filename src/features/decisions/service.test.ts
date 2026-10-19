import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import {
  DECISION_BACKEND_KEY,
  DecisionsService,
  type DecisionRequest,
  type DecisionsNative,
} from "./service";

const request: DecisionRequest = {
  state: "The build is broken on main.",
  questions: {
    urgent: { type: "yes_no", instructions: "It needs attention now." },
  },
};
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
const answered = (backend: string) => ({
  outcome: "answered",
  backend,
  model: "jev-1.13.0",
  answers: { urgent: { type: "yes_no", probability: 0.8 } },
});

it("asks TypeSafe by default and returns native's checked answers", async () => {
  const native = vi.fn<DecisionsNative>(async (backend) => answered(backend));
  const service = new DecisionsService(new Context(), native, memory());
  expect(service.backend()).toBe("typesafe");
  await expect(service.decide(request)).resolves.toEqual(answered("typesafe"));
  expect(native).toHaveBeenCalledWith("typesafe", request);
});

it("ignores a saved value that is not a provider, and unreadable storage", () => {
  const native = vi.fn<DecisionsNative>();
  const junk = memory({ [DECISION_BACKEND_KEY]: "other" });
  expect(new DecisionsService(new Context(), native, junk).backend()).toBe(
    "typesafe",
  );
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  const service = new DecisionsService(new Context(), native, broken);
  expect(service.backend()).toBe("typesafe");
  // Choosing an unknown provider changes nothing and tells no one.
  const listener = vi.fn();
  // Unbound, as React's useSyncExternalStore calls it.
  const { subscribe } = service;
  subscribe(listener);
  service.setBackend("other" as never);
  expect(service.backend()).toBe("typesafe");
  expect(listener).not.toHaveBeenCalled();
});

it("never rejects: no native, refused arguments and a wrong reply are failures", async () => {
  await expect(
    new DecisionsService(new Context(), undefined, memory()).decide(request),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "typesafe",
    reason: "unavailable",
  });
  const refused = vi.fn<DecisionsNative>(async () => {
    throw "invalid args `request` for command `decide`";
  });
  await expect(
    new DecisionsService(new Context(), refused, memory()).decide(request),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "typesafe",
    reason: "invalid_request",
  });
  const broken = vi.fn<DecisionsNative>(async () => {
    throw "decisions.decide not allowed. Permissions associated with this command: []";
  });
  await expect(
    new DecisionsService(new Context(), broken, memory()).decide(request),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "typesafe",
    reason: "service_error",
  });
  for (const reply of [
    null,
    {},
    { ...answered("typesafe"), backend: "other" },
    { outcome: "answered", backend: "typesafe" },
  ]) {
    const odd = vi.fn<DecisionsNative>(async () => reply);
    await expect(
      new DecisionsService(new Context(), odd, memory()).decide(request),
    ).resolves.toEqual({
      outcome: "failed",
      backend: "typesafe",
      reason: "invalid_response",
    });
  }
  const failed = { outcome: "failed", backend: "typesafe", reason: "timeout" };
  await expect(
    new DecisionsService(new Context(), async () => failed, memory()).decide(
      request,
    ),
  ).resolves.toEqual(failed);
});

it("is the injected ctx.decisions plugins get", async () => {
  const ctx = new Context();
  const native = vi.fn<DecisionsNative>(async (backend) => answered(backend));
  new DecisionsService(ctx, native, memory());
  const seen = new Promise<unknown>((resolve) =>
    ctx.inject(["decisions"], (child) =>
      resolve(child.decisions.decide(request)),
    ),
  );
  await expect(seen).resolves.toEqual(answered("typesafe"));
});
