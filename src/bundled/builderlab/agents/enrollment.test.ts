import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createEnrollment } from "./enrollment";
import { enrollmentFixture } from "./enrollment-testing";
import type { RemoteAgent } from "./client";
import { PublishRejected } from "../../../features/relay/outbox";

const agent: RemoteAgent = {
  id: "one",
  name: "Helper",
  pubkey: "ab".repeat(32),
  status: "Active",
};
const owners: ReturnType<typeof enrollmentFixture>[] = [];
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture(kinds?: readonly number[]) {
  const login = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  await login.signIn();
  const h = enrollmentFixture(login, "https://community.example", kinds);
  owners.push(h);
  return {
    ...h,
    login,
    signal: new AbortController().signal,
    client: { delete: vi.fn(async () => {}) },
  };
}

function failDiscovery(h: Awaited<ReturnType<typeof fixture>>) {
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing reader");
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30175)))
      throw new Error("inventory unavailable");
    return query(filters);
  });
  return () => h.query.mockImplementation(query);
}

it("resumes a saved enrollment with the original signed event after a lost receipt", async () => {
  const h = await fixture();
  h.publish.mockRejectedValueOnce(new Error("receipt lost"));
  const context = h.enrollment.capture();
  h.enrollment.remember(context, agent);
  await expect(
    h.enrollment.publish(context, agent, h.signal, () => true),
  ).rejects.toThrow("receipt lost");
  await vi.waitFor(() => expect(h.saved()[0]?.delivery).toBe("unknown"));
  const first = h.publish.mock.calls[0]?.[0];
  await h.restart();
  const restored = createEnrollment(h.relay, h.reader, h.login);
  await restored.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.publish.mock.calls[1]?.[0]).toEqual(first);
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(restored.pending([agent])).toEqual([]);
});

it("recovers the activation-to-outbox gap only for intended Active agents", async () => {
  const h = await fixture();
  await h.enrollment.recover([agent], h.signal, () => true);
  expect(h.sign).not.toHaveBeenCalled();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const restored = createEnrollment(h.relay, h.reader, h.login);
  for (const status of ["Unattested", "Revoked", "Unknown"] as const)
    await restored.recover([{ ...agent, status }], h.signal, () => true);
  expect(h.sign).not.toHaveBeenCalled();
  await restored.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(restored.pending([agent])).toEqual([]);
});

it.each(["community", "account", "card", "abort"])(
  "fences %s changes while registration signing is held",
  async (change) => {
    const h = await fixture();
    const gate = deferred<void>();
    const sign = h.sign.getMockImplementation();
    if (!sign) throw new Error("Missing signer");
    h.sign.mockImplementationOnce(async (event) => {
      await gate.promise;
      return sign(event);
    });
    const controller = new AbortController();
    let active = true;
    const context = h.enrollment.capture();
    h.enrollment.remember(context, agent);
    const result = h.enrollment
      .publish(context, agent, controller.signal, () => active)
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(h.sign).toHaveBeenCalledTimes(1));
      if (change === "community") h.setCommunity("https://other.example");
      if (change === "account") h.login.signOut();
      if (change === "card") active = false;
      if (change === "abort") controller.abort();
      gate.resolve();
      expect(await result).toBeInstanceOf(Error);
      await vi.waitFor(() =>
        expect(h.relay.snapshot().session.outbox?.snapshot()[0]?.delivery).toBe(
          "failed",
        ),
      );
      expect(h.publish).not.toHaveBeenCalled();
      if (change === "community") {
        expect(h.enrollment.pending([agent])).toEqual([]);
        h.setCommunity("https://community.example");
        expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
      }
    } finally {
      gate.resolve();
      await result;
    }
  },
);

it("retains accepted delivery when discovery fails, then refreshes without another publication", async () => {
  const h = await fixture();
  const restoreDiscovery = failDiscovery(h);
  h.enrollment.remember(h.enrollment.capture(), agent);
  await expect(
    h.enrollment.recover([agent], h.signal, () => true),
  ).rejects.toThrow("discovery is pending");
  expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
  restoreDiscovery();
  await h.enrollment.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.enrollment.pending([agent])).toEqual([]);
});

it("drains an inventory read started before publication before refreshing discovery", async () => {
  const h = await fixture();
  const inventory = deferred<Awaited<ReturnType<typeof h.query>>>();
  h.query.mockImplementationOnce(() => inventory.promise);
  const prior = h.relay.snapshot().session.agentChoices.refresh();
  await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
  h.enrollment.remember(h.enrollment.capture(), agent);
  const recovered = h.enrollment.recover([agent], h.signal, () => true);
  try {
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    inventory.resolve([]);
    await prior;
    await recovered;
    expect(h.enrollment.pending([agent])).toEqual([]);
  } finally {
    inventory.resolve([]);
    await Promise.allSettled([prior, recovered]);
  }
});

it.each(["receipt dismissal", "intent removal"])(
  "recovers an interruption during %s after acknowledgment without republishing",
  async (boundary) => {
    const h = await fixture();
    h.enrollment.remember(h.enrollment.capture(), agent);
    const save = h.save.getMockImplementation();
    if (!save) throw new Error("Missing storage");
    if (boundary === "receipt dismissal") {
      h.save.mockImplementation(async (next) => {
        if (!next.length && h.events.length)
          throw new Error("cleanup interrupted");
        return save(next);
      });
    } else {
      vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
        throw new Error("cleanup interrupted");
      });
    }
    await expect(
      h.enrollment.recover([agent], h.signal, () => true),
    ).rejects.toThrow("cleanup interrupted");
    expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
    if (boundary === "receipt dismissal")
      expect(h.saved()[0]?.acknowledged).toBe(true);
    h.save.mockImplementation(save);
    await h.restart();
    await h.enrollment.recover([agent], h.signal, () => true);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
    expect(h.enrollment.pending([agent])).toEqual([]);
  },
);

it("keeps enrollment and deletion intent scoped to the verified account", async () => {
  const h = await fixture();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const other = createOAuthSession(async () => ({
    value: "other-secret",
    account: { subject: "other", email: "a@example.com" },
  }));
  await other.signIn();
  const enrollment = createEnrollment(h.relay, h.reader, other);
  expect(enrollment.pending([agent])).toEqual([]);
  await enrollment.recover([agent], h.signal, () => true);
  expect(h.publish).not.toHaveBeenCalled();
  await h.enrollment.remove(agent, h.client, h.signal, () => true);
  expect(h.enrollment.deleting(agent)).toBe(true);
  expect(enrollment.deleting(agent)).toBe(false);
});

it.each([new PublishRejected("denied"), new Error("receipt lost")])(
  "does not delete the runtime after unconfirmed relay delivery: %s",
  async (failure) => {
    const h = await fixture();
    h.publish.mockRejectedValueOnce(failure);
    await expect(
      h.enrollment.remove(agent, h.client, h.signal, () => true),
    ).rejects.toThrow(failure.message);
    expect(h.client.delete).not.toHaveBeenCalled();
    expect(h.enrollment.deleting(agent)).toBe(true);
    expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
  },
);

it("keeps deletion intent across restart and retries with a fresh event after backend failure", async () => {
  const startedAt = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  const h = await fixture();
  h.enrollment.remember(h.enrollment.capture(), agent);
  await h.enrollment.recover([agent], h.signal, () => true);
  h.enrollment.remember(h.enrollment.capture(), agent);
  h.client.delete.mockRejectedValueOnce(new Error("backend offline"));
  await expect(
    h.enrollment.remove(agent, h.client, h.signal, () => true),
  ).rejects.toThrow("backend offline");
  expect(h.relay.snapshot().session.agentChoices.snapshot().identities).toEqual(
    [],
  );
  const first = h.events.find((event) => event.kind === 5);
  expect(first).toMatchObject({
    pubkey: h.viewer,
    content: "",
    tags: [
      ["a", `30177:${h.viewer}:${agent.pubkey}`],
      ["client-id", expect.any(String)],
    ],
  });
  await h.restart();
  const restored = createEnrollment(h.relay, h.reader, h.login);
  expect(restored.pending([agent])).toEqual([]);
  await restored.recover([agent], h.signal, () => true);
  expect(h.events.map((event) => event.kind)).toEqual([30177, 5]);
  clock.mockReturnValue(startedAt + 20 * 60_000);
  await restored.remove(agent, h.client, h.signal, () => true);
  const second = h.events.at(-1);
  expect(second?.kind).toBe(5);
  expect(second?.id).not.toBe(first?.id);
  expect(second?.created_at).toBe((first?.created_at ?? 0) + 20 * 60);
  expect(h.client.delete).toHaveBeenCalledTimes(2);
  // A stale row/intent in another window remains fenced even after successful deletion.
  expect(restored.deleting(agent)).toBe(true);
  await expect(
    restored.publish(restored.capture(), agent, h.signal, () => true),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it.each(["community", "account", "card", "abort"])(
  "does not contact Builderlab after %s changes during deletion publication",
  async (change) => {
    const h = await fixture();
    const gate = deferred<void>();
    const publish = h.publish.getMockImplementation();
    if (!publish) throw new Error("Missing publisher");
    h.publish.mockImplementationOnce(async (event) => {
      await gate.promise;
      return publish(event);
    });
    let active = true;
    const controller = new AbortController();
    const removing = h.enrollment
      .remove(agent, h.client, controller.signal, () => active)
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
      if (change === "community") h.setCommunity("https://other.example");
      if (change === "account") h.login.signOut();
      if (change === "card") active = false;
      if (change === "abort") controller.abort();
      gate.resolve();
      expect(await removing).toMatchObject({ name: "AbortError" });
      expect(h.client.delete).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await removing;
    }
  },
);

it.each([
  { stage: "signing", elapsed: 0, abort: false },
  { stage: "transport", elapsed: 0, abort: false },
  { stage: "transport", elapsed: 30_000, abort: false },
  { stage: "transport", elapsed: 0, abort: true },
])(
  "orders deletion after registration held in $stage ($elapsed ms later, abort=$abort)",
  async ({ stage, elapsed, abort }) => {
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const h = await fixture();
    h.enrollment.remember(h.enrollment.capture(), agent);
    const gate = deferred<void>();
    if (stage === "signing") {
      const sign = h.sign.getMockImplementation();
      if (!sign) throw new Error("Missing signer");
      h.sign.mockImplementationOnce(async (event) => {
        await gate.promise;
        return sign(event);
      });
    } else {
      const publish = h.publish.getMockImplementation();
      if (!publish) throw new Error("Missing publisher");
      h.publish.mockImplementationOnce(async (event) => {
        await gate.promise;
        return publish(event);
      });
    }
    const controller = new AbortController();
    const enrolling = h.enrollment
      .recover([agent], controller.signal, () => true)
      .catch((error) => error);
    let removing: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() =>
        expect(stage === "signing" ? h.sign : h.publish).toHaveBeenCalledTimes(
          1,
        ),
      );
      clock.mockReturnValue(startedAt + elapsed);
      const otherWindow = createEnrollment(h.relay, h.reader, h.login);
      removing = otherWindow
        .remove(agent, h.client, h.signal, () => true)
        .catch((error) => error);
      await vi.waitFor(() => expect(otherWindow.deleting(agent)).toBe(true));
      if (abort) {
        controller.abort();
        // Inspect the real LockManager after cancellation: the deletion stays
        // queued until the issued registration request settles.
        await vi.waitFor(async () => {
          const locks = await navigator.locks.query();
          expect(
            locks.pending?.some(({ name }) =>
              name?.startsWith("buzz.builderlab.agent:"),
            ),
          ).toBe(true);
        });
      }
      expect(h.client.delete).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      gate.resolve();
      expect(await enrolling).toMatchObject(
        stage === "signing"
          ? { message: "Channel addition cancelled" }
          : { name: "AbortError" },
      );
      expect(await removing).toBeUndefined();
      expect(h.events.map((event) => event.kind)).toEqual(
        stage === "signing" ? [5] : [30177, 5],
      );
      expect(h.client.delete).toHaveBeenCalledTimes(1);
      await h.relay.snapshot().session.agentChoices.refresh();
      expect(
        h.relay.snapshot().session.agentChoices.snapshot().identities,
      ).toEqual([]);
      expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
    } finally {
      gate.resolve();
      await Promise.allSettled([enrolling, removing]);
    }
  },
);

it.each(["session replacement", "silent disposal"])(
  "releases the registration lock after %s without discarding its receipt",
  async (boundary) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await fixture();
    h.enrollment.remember(h.enrollment.capture(), agent);
    const started = deferred<void>();
    const publication = deferred<void>();
    h.publish.mockImplementationOnce(() => {
      started.resolve();
      return publication.promise;
    });
    const draining = deferred<void>();
    const subscribe = h.relay.subscribe;
    vi.spyOn(h.relay, "subscribe").mockImplementation((listener) => {
      const stop = subscribe(listener);
      draining.resolve();
      return stop;
    });
    const controller = new AbortController();
    let settled = false;
    const enrolling = h.enrollment
      .recover([agent], controller.signal, () => true)
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await started.promise;
      const event = h.publish.mock.calls[0]?.[0];
      controller.abort();
      await draining.promise;
      if (boundary === "session replacement") await h.restart();
      else {
        await h.dispose();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await enrolling).toMatchObject({ name: "AbortError" });
      if (boundary === "silent disposal") await h.restart();
      expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([
        expect.objectContaining({
          delivery: "unknown",
          event: expect.objectContaining({ id: event?.id }),
        }),
      ]);
      expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
      const restored = createEnrollment(h.relay, h.reader, h.login);
      await restored.recover([agent], h.signal, () => true);
      expect(h.publish).toHaveBeenCalledTimes(2);
      expect(h.publish.mock.calls[1]?.[0]).toEqual(event);
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(restored.pending([agent])).toEqual([]);
    } finally {
      publication.resolve();
    }
  },
);

it("keeps backend deletion retryable when discovery fails after relay acceptance", async () => {
  const h = await fixture();
  const restoreDiscovery = failDiscovery(h);
  await expect(
    h.enrollment.remove(agent, h.client, h.signal, () => true),
  ).rejects.toThrow("discovery is pending");
  expect(h.client.delete).not.toHaveBeenCalled();
  expect(h.enrollment.deleting(agent)).toBe(true);
  restoreDiscovery();
  await h.enrollment.remove(agent, h.client, h.signal, () => true);
  expect(h.client.delete).toHaveBeenCalledTimes(1);
  expect(h.events.map((event) => event.kind)).toEqual([5, 5]);
});

it.each([
  { delivery: "failed", outcome: "retires" },
  { delivery: "seen", outcome: "retires" },
  { delivery: "unknown", outcome: "retains" },
])(
  "$outcome a $delivery registration receipt after deletion",
  async ({ delivery }) => {
    const h = await fixture();
    const restoreDiscovery = delivery === "seen" ? failDiscovery(h) : undefined;
    if (delivery === "failed")
      h.publish.mockRejectedValueOnce(new PublishRejected("denied"));
    else if (delivery === "unknown")
      h.publish.mockRejectedValueOnce(new Error("receipt lost"));
    h.enrollment.remember(h.enrollment.capture(), agent);
    await expect(
      h.enrollment.recover([agent], h.signal, () => true),
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(h.relay.snapshot().session.outbox?.snapshot()[0]?.delivery).toBe(
        delivery,
      ),
    );
    restoreDiscovery?.();
    const receipt = h.relay.snapshot().session.outbox?.snapshot()[0];
    await h.enrollment.remove(agent, h.client, h.signal, () => true);
    expect(h.client.delete).toHaveBeenCalledTimes(1);
    await h.restart();
    expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual(
      delivery === "unknown"
        ? [
            expect.objectContaining({
              delivery: "unknown",
              recovery: {
                key: `builderlab:register:${agent.pubkey}`,
                value: agent.pubkey,
              },
            }),
          ]
        : [],
    );
    expect(h.saved().map((item) => item.event.id)).toEqual(
      delivery === "unknown" ? [receipt?.event.id] : [],
    );
    expect(h.enrollment.deleting(agent)).toBe(true);
  },
);

it.each([
  { failure: "unsupported kind 5", error: "Connect" },
  { failure: "unavailable cross-window coordination", error: "coordinate" },
  { failure: "storage failure", error: "storage full" },
])(
  "preserves enrollment intent and makes no deletion writes after $failure",
  async ({ failure, error }) => {
    const h = await fixture(
      failure === "unsupported kind 5" ? [30177] : undefined,
    );
    h.enrollment.remember(h.enrollment.capture(), agent);
    if (failure === "unavailable cross-window coordination")
      vi.stubGlobal("navigator", {});
    if (failure === "storage failure")
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage full");
      });
    await expect(
      h.enrollment.remove(agent, h.client, h.signal, () => true),
    ).rejects.toThrow(error);
    expect(h.enrollment.deleting(agent)).toBe(false);
    expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
    expect(h.events).toEqual([]);
    expect(h.client.delete).not.toHaveBeenCalled();
  },
);
