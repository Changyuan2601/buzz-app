import { retryRead } from "./read-retry";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { ReadRetriesExhausted, ReadError } from "./errors";
import { keypair, profile, roster } from "./testing";
import type { LiveCallbacks } from "./live";
import type { ReadFilter, RelayEvent } from "./events";

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const viewer = keypair(),
    relay = keypair();
  const query = vi.fn(
    async (_filters: readonly ReadFilter[], _signal?: AbortSignal) =>
      [] as RelayEvent[],
  );
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const filter = [{ kinds: [0], authors: [viewer.pubkey], limit: 1 }];
  return {
    owner,
    query,
    viewer,
    relay,
    filter,
    emit: (events: RelayEvent[]) => live.receive(events),
  };
}

it("retries a finite public read without changing transport edge classification", async () => {
  const h = setup();
  h.query.mockRejectedValueOnce(new ReadError("unavailable", "edge", 403));
  const pending = h.owner.session.read(h.filter);
  await vi.advanceTimersByTimeAsync(749);
  expect(h.query).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual([]);
  expect(h.query).toHaveBeenCalledTimes(2);
});

it("retains observed data and coalesces refreshes during finite recovery", async () => {
  const h = setup();
  const row = profile(h.viewer, { name: "Kept" });
  h.query.mockResolvedValueOnce([row]);
  const view = h.owner.session.observe(h.filter);
  await view.refresh();
  h.query.mockRejectedValueOnce(new TypeError("offline"));
  const pending = view.refresh();
  await vi.advanceTimersByTimeAsync(0);
  await view.refresh();
  expect(h.query).toHaveBeenCalledTimes(2);
  expect(view.snapshot().status).toBe("loading");
  expect(view.snapshot().events.map((event) => event.id)).toContain(row.id);
  await vi.advanceTimersByTimeAsync(750);
  await pending;
  expect(view.snapshot().status).toBe("ready");
  expect(h.query).toHaveBeenCalledTimes(3);
  view.dispose();
});

it("leaves roster errors transient for their existing recovery owner", async () => {
  const h = setup();
  h.query.mockRejectedValue(new ReadError("unavailable", "offline", 503));
  h.owner.session.channels.refreshList?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.session.live.snapshot().roster).toMatchObject({
    state: "error",
    transient: true,
  });
  expect(h.query).toHaveBeenCalledOnce();
});

it.each(["caller", "cache", "dispose", "access"] as const)(
  "%s cancels a finite public read's backoff",
  async (action) => {
    const h = setup();
    h.emit([roster(h.relay, "channel", [h.viewer.pubkey], 10)]);
    const caller = new AbortController();
    h.query.mockRejectedValue(new TypeError("offline"));
    const pending = h.owner.session.read(h.filter, { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    const before = h.query.mock.calls.filter(([filters]) =>
      filters[0]?.kinds?.includes(0),
    ).length;
    if (action === "caller") caller.abort();
    else if (action === "cache") await h.owner.clearCache();
    else if (action === "dispose") h.owner.dispose();
    else h.emit([roster(h.relay, "channel", [], 11)]);
    await rejected;
    await vi.advanceTimersByTimeAsync(7000);
    expect(
      h.query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(0)),
    ).toHaveLength(before);
  },
);

it("surfaces a long public admission pause without holding the read pending", async () => {
  const h = setup();
  const error = new ReadError("unavailable", "quota", 429, 60_000);
  h.query.mockRejectedValue(error);
  await expect(h.owner.session.read(h.filter)).rejects.toMatchObject({
    cause: error,
  });
  expect(h.query).toHaveBeenCalledOnce();
});

it("marks a finite window as exhausted so an outer caller cannot restart it", async () => {
  const h = setup();
  h.query.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    throw new ReadError("unavailable", "offline");
  });
  const signal = new AbortController().signal;
  const pending = retryRead(
    () => h.owner.session.read(h.filter, { signal }),
    signal,
  );
  const rejected = expect(pending).rejects.toBeInstanceOf(ReadRetriesExhausted);
  await vi.advanceTimersByTimeAsync(20000);
  await rejected;
  expect(h.query).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(7000);
  expect(h.query).toHaveBeenCalledTimes(3);
});
