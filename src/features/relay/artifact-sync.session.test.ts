import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import { keypair, roster, scriptedTransport, signed } from "./testing";
import type { ArtifactSyncSink } from "./artifact-sync";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
const C1 = "11111111-1111-4111-8111-111111111111";
const filter = { artifact: "current", "#h": [C1] };

function harness(artifactSync: boolean) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const sinks: ArtifactSyncSink[] = [];
  const closes = vi.fn();
  let incoming!: (events: readonly RelayEvent[]) => void;
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    ...(artifactSync ? { artifactSync: true as const } : {}),
    subscribe(callbacks) {
      incoming = callbacks.receive;
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncArtifacts(_filter, sink) {
          sinks.push(sink);
          return closes;
        },
      };
    },
  });
  owners.push(owner);
  return {
    owner,
    sinks,
    closes,
    emit: (events: readonly RelayEvent[]) => incoming(events),
  };
}
const head = (d: string) =>
  signed(viewer, {
    kind: 45010,
    content: d,
    tags: [
      ["d", d],
      ["h", C1],
    ],
  });

it("reports unsupported when the relay does not advertise sync", () => {
  const { owner, sinks } = harness(false);
  const view = owner.session.artifacts.sync(filter);
  expect(view.snapshot().status).toBe("unsupported");
  expect(sinks).toHaveLength(0);
});

it("opens on live traffic and ends every view at session teardown", () => {
  const { owner, sinks, closes } = harness(true);
  const view = owner.session.artifacts.sync(filter);
  expect(sinks).toHaveLength(1);
  expect(view.snapshot().status).toBe("loading");
  nth(sinks, 0).eose();
  expect(view.snapshot().status).toBe("live");
  owner.dispose();
  expect(closes).toHaveBeenCalledOnce();
});

it("refuses a filter the relay would refuse, at the call site", () => {
  const { owner } = harness(true);
  expect(() =>
    owner.session.artifacts.sync({ artifact: "current", limit: 10 }),
  ).toThrow();
});

it.each(["access loss", "cache clear"])(
  "drops a live set on %s and fences the old sync's late frames",
  async (cause) => {
    const h = harness(true);
    h.emit([roster(relay, C1, [viewer.pubkey], 10)]);
    const view = h.owner.session.artifacts.sync(filter);
    const secret = head("a");
    nth(h.sinks, 0).event(secret);
    nth(h.sinks, 0).eose();
    expect(view.snapshot().events).toEqual([secret]);
    const seen: number[] = [];
    view.subscribe(() => seen.push(view.snapshot().events.length));

    if (cause === "access loss") h.emit([roster(relay, C1, [], 11)]);
    else await h.owner.clearCache();
    // No relay message is needed: the held set is gone at once.
    expect(view.snapshot()).toEqual({ status: "loading", events: [] });
    expect(seen).toEqual([0]);
    expect(h.closes).toHaveBeenCalledOnce();
    // The relay reapplies access to a new sync.
    expect(h.sinks).toHaveLength(2);

    nth(h.sinks, 0).event(secret);
    nth(h.sinks, 0).eose();
    expect(view.snapshot()).toEqual({ status: "loading", events: [] });
    const fresh = head("b");
    nth(h.sinks, 1).event(fresh);
    nth(h.sinks, 1).eose();
    expect(view.snapshot()).toEqual({ status: "live", events: [fresh] });
  },
);

it("cancels the pending retry when a listener restarts the view", async () => {
  vi.useFakeTimers();
  const h = harness(true);
  const view = h.owner.session.artifacts.sync(filter);
  nth(h.sinks, 0).eose();
  let cleared: Promise<void> | undefined;
  view.subscribe(() => {
    if (view.snapshot().status === "stale") cleared ??= h.owner.clearCache();
  });
  nth(h.sinks, 0).closed("resync: lag");
  await cleared;
  expect(h.sinks).toHaveLength(2);
  // The retry armed by the first close must not open a second live sync.
  vi.advanceTimersByTime(120_000);
  expect(h.sinks).toHaveLength(2);
  view.dispose();
  expect(h.closes).toHaveBeenCalledOnce();
});

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
