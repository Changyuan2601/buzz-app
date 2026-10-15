import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import type { RelayEvent } from "./events";
import { flush, keypair, message, signed } from "./testing";
import { createUnread } from "./unread";

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert(value !== undefined, "Missing fixture entry");
  return value;
}

async function setup(count = 3) {
  const viewer = keypair(),
    peer = keypair();
  let roster: readonly ChannelSummary[] = Array.from(
    { length: count },
    (_, i) => ({
      id: `c${i}`,
      name: `Channel ${i}`,
      members: [viewer.pubkey],
    }),
  );
  let changed = () => {};
  const channels: ChannelQueries = {
    list: vi.fn(() => ({ status: "ready" as const, channels: roster })),
    subscribeList(listener) {
      changed = listener;
      return () => {};
    },
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  let journal: ReadJournal | undefined;
  const reader = { read: vi.fn(async () => []) };
  const reads = createReadState({
    viewer: viewer.pubkey,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer.pubkey);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const state = vi.spyOn(reads, "state");
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer: viewer.pubkey,
  });
  owners.push(owner);
  const targets = roster.map(({ id }) => ({
    kind: "channel" as const,
    channelId: id,
  }));
  const rows = roster.map(({ id }) => message(peer, id, "seed", 11));
  owner.accept(rows);
  const listeners = targets.map(() => vi.fn());
  const stops = targets.map((target, i) =>
    owner.capability.subscribe(target, at(listeners, i)),
  );
  const reset = () => {
    state.mockClear();
    vi.mocked(channels.list).mockClear();
  };
  reset();
  return {
    owner,
    unread: owner.capability,
    viewer,
    peer,
    rows,
    targets,
    listeners,
    stops,
    state,
    channels,
    reader,
    reads,
    reset,
    changeList(patch: (channel: ChannelSummary) => ChannelSummary) {
      roster = roster.map(patch);
      changed();
    },
  };
}

it("does not trust workflow-owner metadata without a configured relay identity", async () => {
  const h = await setup(1);
  const row = message(h.peer, "c0", "workflow-shaped output", 12, [
    ["p", h.viewer.pubkey],
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", h.viewer.pubkey],
  ]);
  h.owner.accept([row]);
  expect(h.unread.attention("c0", row.id)).toMatchObject({
    category: "mention",
    mentioned: true,
    unread: true,
  });
});

it("recomputes only the affected subscribed channel, not every cached sidebar selector", async () => {
  const h = await setup(128);
  h.owner.accept([message(h.peer, "c0", "new", 12)]);
  expect(h.state).toHaveBeenCalledTimes(1);
  expect(h.channels.list).toHaveBeenCalledTimes(3); // admission + two selector inputs
  expect(h.listeners[0]).toHaveBeenCalledOnce();
  expect(
    h.listeners.slice(1).every((listener) => listener.mock.calls.length === 0),
  ).toBe(true);
  expect(h.reader.read).not.toHaveBeenCalled();
});

it("ignores preview/name changes, but recomputes the one channel whose DM metadata changed", async () => {
  const h = await setup(128);
  h.changeList((channel) => ({
    ...channel,
    name: "renamed",
    preview: "new preview",
  }));
  expect(h.state).not.toHaveBeenCalled();
  expect(h.channels.list).toHaveBeenCalledTimes(1);
  h.reset();
  h.changeList((channel) =>
    channel.id === "c0" ? { ...channel, channelType: "dm" } : channel,
  );
  expect(h.state).toHaveBeenCalledTimes(1);
  expect(h.channels.list).toHaveBeenCalledTimes(3);
  expect(h.unread.snapshot(at(h.targets, 0))).toMatchObject({
    observedCount: 1,
    attentionCount: 1,
  });
  h.reset();
  h.changeList((channel) => {
    if (channel.id !== "c0") return channel;
    const { channelType: _type, ...rest } = channel;
    return rest;
  });
  expect(h.state).toHaveBeenCalledTimes(1);
  expect(h.unread.snapshot(at(h.targets, 0)).attentionCount).toBe(0);
});

it("lazily refreshes dormant selectors and preserves identity when their value is unchanged", async () => {
  const h = await setup();
  const target = at(h.targets, 0);
  const before = h.unread.snapshot(target);
  at(h.stops, 0)();
  const own = message(h.viewer, "c0", "own message", 12);
  h.owner.accept([own]);
  expect(h.state).not.toHaveBeenCalled();
  const after = h.unread.snapshot(target);
  expect(after).not.toBe(before);
  expect(after.latestMessage).toEqual({ id: own.id, createdAt: 12 });
  expect(h.unread.snapshot(target)).toBe(after);
  expect(h.state).toHaveBeenCalledTimes(1);
  h.reset();
  h.owner.accept([message(h.peer, "c0", "unread message", 13)]);
  expect(h.state).not.toHaveBeenCalled();
  const listener = vi.fn();
  h.unread.subscribe(target, listener);
  expect(h.state).toHaveBeenCalledTimes(1);
  expect(h.unread.snapshot(target).observedCount).toBe(2);
  h.reset();
  h.owner.accept([message(h.peer, "c0", "subscribed again", 14)]);
  expect(h.state).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledOnce();
});

it("keeps read-state and freshness invalidation global", async () => {
  const h = await setup();
  const before = h.targets.map(h.unread.snapshot);
  const activity = h.unread.activity("c0");
  const activityChanges = vi.fn();
  h.unread.subscribeActivity("c0", activityChanges);
  expect(activity).toMatchObject({
    coverage: "observed",
    freshness: "observed",
    items: [],
  });
  h.reset();
  const readChanges = vi.fn();
  h.reads.subscribe(readChanges);
  await h.reads.markLocalUnread("c0", () => true);
  expect(readChanges).toHaveBeenCalled();
  expect(h.unread.snapshot(at(h.targets, 0)).manual).toBe("local-only");
  expect(h.unread.snapshot(at(h.targets, 1))).toBe(before[1]);
  expect(h.unread.activity("c0")).toBe(activity);
  expect(activityChanges).not.toHaveBeenCalled();
  h.owner.stale();
  expect(
    h.targets.map((target) => h.unread.snapshot(target).freshness),
  ).toEqual(["stale", "stale", "stale"]);
  expect(h.unread.activity("c0")).toMatchObject({
    freshness: "stale",
    items: [],
  });
  expect(activityChanges).toHaveBeenCalledOnce();
  const beforeFreshnessRecovery = h.listeners.map(
    (listener) => listener.mock.calls.length,
  );
  h.reset();
  h.owner.accept([message(h.peer, "c0", "fresh evidence", 12)]);
  expect(h.listeners.map((listener) => listener.mock.calls.length)).toEqual(
    beforeFreshnessRecovery.map((count) => count + 1),
  );
  expect(activityChanges).toHaveBeenCalledTimes(2);
  expect(
    h.targets.map((target) => h.unread.snapshot(target).freshness),
  ).toEqual(["observed", "observed", "observed"]);
});

it.each([5, 9005])(
  "kind-%s deletion invalidates every target channel before reentrant snapshot reads",
  async (kind) => {
    const h = await setup();
    const dormant = {
      kind: "message" as const,
      channelId: "c1",
      messageId: at(h.rows, 1).id,
    };
    expect(h.unread.snapshot(dormant).observedCount).toBe(1);
    const seen: (number | null)[][] = [];
    h.unread.subscribe(at(h.targets, 0), () =>
      seen.push([
        h.unread.snapshot(at(h.targets, 1)).observedCount,
        h.unread.snapshot(dormant).observedCount,
      ]),
    );
    h.reset();
    h.owner.accept([
      signed(h.peer, {
        kind,
        content: "",
        tags: [
          ["h", "c0"],
          ["e", at(h.rows, 0).id],
          ["e", at(h.rows, 1).id],
        ],
      }),
    ]);
    expect(seen).toEqual([[0, 0]]);
    expect(h.state).toHaveBeenCalledTimes(3); // two subscribed + one lazy reentrant read
    expect(h.listeners[2]).not.toHaveBeenCalled();
  },
);

it("invalidates subscribed and dormant selectors globally on clear and capacity loss", async () => {
  const h = await setup();
  at(h.stops, 1)();
  h.owner.clear();
  expect(h.targets.map((target) => h.unread.snapshot(target))).toEqual(
    h.targets.map((target) =>
      expect.objectContaining({
        target,
        coverage: "unknown",
        freshness: "unknown",
        observedCount: null,
      }),
    ),
  );
  h.owner.accept(h.rows);
  h.owner.accept([message(h.peer, "c0", "x".repeat(8 * 1024 * 1024), 12)]);
  for (const target of h.targets)
    expect(h.unread.snapshot(target)).toMatchObject({
      coverage: "unknown",
      freshness: "stale",
      observedCount: null,
      error: "Unread observation capacity reached; refresh available",
    });
});

it("reconnect retains background marker and evidence priority", async () => {
  const h = await setup();
  await h.unread.ensure();
  h.reader.read.mockClear();
  const refresh = vi.spyOn(h.reads, "refresh");
  h.owner.reconnect();
  await vi.waitFor(() => expect(h.reader.read).toHaveBeenCalledOnce());
  expect(refresh).toHaveBeenCalledWith();
  expect(h.reader.read).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ priority: "background" }),
  );
});

/** Seeded PRNG (mulberry32); the repo has no property-testing dependency. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const channelOf = (event: RelayEvent) =>
  event.tags.find(([name]) => name === "h")?.[1] ?? "";
/** Every public projection the evidence index feeds. */
function projections(
  h: Awaited<ReturnType<typeof setup>>,
  emitted: readonly RelayEvent[],
  roots: readonly RelayEvent[],
) {
  return {
    channels: h.targets.map((target) => h.unread.snapshot(target)),
    threads: roots.map((root) =>
      h.unread.snapshot({
        kind: "thread",
        channelId: channelOf(root),
        rootId: root.id,
      }),
    ),
    attention: emitted.map((event) =>
      h.unread.attention(channelOf(event), event.id),
    ),
    activity: h.targets.map(({ channelId }) => h.unread.activity(channelId)),
    following: roots.map((root) =>
      h.unread.following(channelOf(root), root.id),
    ),
    inbox: h.unread.inbox(),
  };
}
/** With every channel still allowed, `purge` deletes nothing and only forces
 * the evidence index to rebuild, so it is the rescan oracle for the per-event
 * append path in `accept`. */
function expectRebuiltToMatch(
  h: Awaited<ReturnType<typeof setup>>,
  emitted: readonly RelayEvent[],
  roots: readonly RelayEvent[],
  label: string,
) {
  const incremental = projections(h, emitted, roots);
  h.owner.purge();
  expect(projections(h, emitted, roots), label).toEqual(incremental);
}

it("resolves replies that arrive before their root, and the root's deletion, like a rescan", async () => {
  const h = await setup(1);
  h.changeList((channel) => ({ ...channel, channelType: "dm" }));
  const root = message(h.peer, "c0", "root", 12);
  const replies = Array.from({ length: 20 }, (_, i) =>
    message(i % 3 === 0 ? h.viewer : h.peer, "c0", `reply ${i}`, 13 + i, [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
      ...(i === 5 ? [["p", h.viewer.pubkey]] : []),
    ]),
  );
  h.owner.accept(replies);
  expectRebuiltToMatch(h, replies, [], "replies before root");
  h.owner.accept([root]);
  expectRebuiltToMatch(h, [...replies, root], [root], "root after replies");
  expect(h.unread.attention("c0", at(replies, 1).id)).toMatchObject({
    status: "eligible",
    rootId: root.id,
  });
  h.owner.accept([
    signed(h.peer, {
      kind: 5,
      content: "",
      created_at: 40,
      tags: [["e", root.id]],
    }),
  ]);
  expectRebuiltToMatch(h, [...replies, root], [root], "root deleted");
  expect(h.unread.attention("c0", root.id)).toMatchObject({
    status: "ineligible",
  });
  expect(h.unread.attention("c0", at(replies, 1).id)).toMatchObject({
    rootId: root.id,
  });
});

it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
  "appends live evidence identically to a full rescan (seed %i)",
  async (seed) => {
    const h = await setup();
    h.changeList((channel) =>
      channel.id === "c2" ? { ...channel, channelType: "dm" } : channel,
    );
    const random = prng(seed);
    const pick = <T>(values: readonly T[]) =>
      at(values, Math.floor(random() * values.length));
    const chance = (p: number) => random() < p;
    const third = keypair();
    const authors = [h.viewer, h.peer, third];
    const authorOf = (event: RelayEvent) =>
      authors.find((key) => key.pubkey === event.pubkey) ?? h.peer;
    const channels = h.targets.map(({ channelId }) => channelId);
    const emitted: RelayEvent[] = [];
    const roots: RelayEvent[] = [];
    let held: { event: RelayEvent; due: number }[] = [];
    let clock = 12;
    const content = (
      author: ReturnType<typeof keypair>,
      channelId: string,
      tags: string[][],
    ) => message(author, channelId, `m${clock}`, clock++, tags);
    const viewerTags = () => [
      ...(chance(0.2) ? [["p", h.viewer.pubkey]] : []),
      ...(chance(0.1) ? [["broadcast", "1"]] : []),
    ];
    const replyTo = (parent: RelayEvent, rootId: string) =>
      content(pick(authors), channelOf(parent), [
        ["e", rootId, "", "root"],
        ["e", parent.id, "", "reply"],
        ...viewerTags(),
      ]);
    for (let step = 0; step < 100; step++) {
      const batch: RelayEvent[] = [];
      // Messages whose replies already arrived in earlier batches.
      for (const { event } of held.filter((item) => item.due <= step)) {
        batch.push(event);
        roots.push(event);
        emitted.push(event);
      }
      held = held.filter((item) => item.due > step);
      const size = 1 + Math.floor(random() * 4);
      for (let i = 0; i < size; i++) {
        const op = random();
        if (op < 0.25 || !emitted.length) {
          const event = content(pick(authors), pick(channels), viewerTags());
          batch.push(event);
          roots.push(event);
          emitted.push(event);
        } else if (op < 0.45) {
          const root = pick(roots);
          const event = replyTo(root, root.id);
          batch.push(event);
          emitted.push(event);
        } else if (op < 0.6) {
          // A reply naming another reply as its root: the chain walk resolves it.
          const parent = pick(emitted);
          const event = replyTo(parent, parent.id);
          batch.push(event);
          emitted.push(event);
        } else if (op < 0.7) {
          // A reply to a message that arrives 1–6 batches later.
          const future = content(pick(authors), pick(channels), viewerTags());
          held.push({ event: future, due: step + Math.floor(random() * 6) });
          const event = replyTo(future, future.id);
          batch.push(event);
          emitted.push(event);
        } else if (op < 0.85) {
          // A deletion by the author, the viewer, or a third party (forged).
          const target = pick(emitted);
          batch.push(
            signed(pick([authorOf(target), h.viewer, third]), {
              kind: chance(0.5) ? 5 : 9005,
              content: "",
              created_at: clock++,
              tags: [["e", target.id]],
            }),
          );
        } else if (op < 0.93) {
          const target = pick(emitted);
          batch.push(
            signed(authorOf(target), {
              kind: 40003,
              content: "edited",
              created_at: clock++,
              tags: [["e", target.id]],
            }),
          );
        } else {
          batch.push(pick(emitted)); // duplicate re-delivery
        }
      }
      h.owner.accept(batch);
      expectRebuiltToMatch(h, emitted, roots, `seed ${seed} step ${step}`);
      // Let the conversation lookups this step queued resolve, as between live pushes.
      await flush();
    }
  },
);
