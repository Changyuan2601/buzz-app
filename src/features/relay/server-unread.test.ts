// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import {
  createReadApi,
  type ReadApiHost,
  type ServerChannelRow,
} from "./read-api";
import type { RelayReader } from "./reader";
import { serverReadDecision, withServerReadState } from "./server-unread";
import type { UnreadCapability, UnreadSnapshot } from "./unread";

const viewer = "a".repeat(64);
const channel = "00000000-0000-4000-8000-000000000001";
const id = (n: number) => n.toString(16).padStart(64, "0");
const root = id(10);
const message = (n: number, tags: string[][] = []): RelayEvent =>
  ({
    id: id(n),
    pubkey: "b".repeat(64),
    kind: 9,
    created_at: 1_700_000_000 + n,
    content: "",
    sig: "",
    tags: [["h", channel], ...tags],
  }) as RelayEvent;
const reply = (n: number) => message(n, [["e", root, "", "reply"]]);

function setup(
  channelRow: ServerChannelRow,
  coverage?: ReadApiHost["coverage"],
) {
  const write = vi.fn<ReadApiHost["write"]>(async (intents) => ({
    outcomes: intents.map(() => ({ status: "applied" })),
  }));
  const host: ReadApiHost = {
    capabilities: ["follow", "threads", "ping"],
    eligibleKinds: [9],
    maxChannels: 20,
    maxIntents: 100,
    sidebar: async () => ({ channels: [channelRow], next_cursor: null }),
    write,
    ...(coverage ? { coverage } : {}),
  };
  localStorage.setItem("k:started", "1");
  const api = createReadApi({
    host,
    viewer,
    storageKey: "k",
    isDm: () => false,
    rootAuthor: () => undefined,
  });
  const events = new Map<string, RelayEvent>();
  const base = (target: UnreadSnapshot["target"]): UnreadSnapshot => ({
    target,
    observedCount: 0,
    attentionCount: 0,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  });
  const attention = new Map<string, { unread: boolean; mentioned: boolean }>();
  const local = {
    snapshot: base,
    attention: (_channelId: string, messageId: string) =>
      attention.get(messageId) ?? { unread: false, mentioned: false },
    reading: () => ({
      view: () => undefined,
      observe: async () => undefined,
      catchUp: async () => undefined,
      dispose: () => undefined,
    }),
    following: () => false,
    follow: () => undefined,
    markMessageRead: async () => ({}),
  } as unknown as UnreadCapability;
  const unread = withServerReadState({
    local,
    api,
    event: (eventId) => events.get(eventId),
    isDm: () => false,
    canFollow: true,
  });
  const decision = serverReadDecision({
    api,
    reader: { read: async () => [] } as unknown as RelayReader,
    event: (eventId) => events.get(eventId),
  });
  return { api, unread, decision, events, attention, write };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

it("takes channel and thread counts from the relay's rows", async () => {
  const { api, unread } = setup({
    channel_id: channel,
    unread: true,
    mentions: 2,
    read_through_id: id(1),
    latest_id: id(3),
    threads: [
      {
        root_id: root,
        unread: true,
        mentions: 0,
        read_through_id: null,
        latest_id: id(11),
      },
    ],
  });
  await api.load();
  expect(
    unread.snapshot({ kind: "channel", channelId: channel }),
  ).toMatchObject({ observedCount: 3, attentionCount: 3 });
  expect(
    unread.snapshot({ kind: "thread", channelId: channel, rootId: root }),
  ).toMatchObject({ observedCount: 1, attentionCount: 1 });
  expect(
    unread.snapshot({ kind: "thread", channelId: channel, rootId: id(20) }),
  ).toMatchObject({ observedCount: 0 });
  api.dispose();
});

it("answers per message from coverage and asks again after a stale answer", async () => {
  const coverage = vi.fn<NonNullable<ReadApiHost["coverage"]>>();
  const { api, decision } = setup(
    {
      channel_id: channel,
      unread: true,
      mentions: 0,
      read_through_id: id(1),
      latest_id: id(4),
      threads: [],
    },
    coverage,
  );
  await api.load();
  expect(api.stale(9)).toBe(false);
  expect(decision.unread(message(4), channel, undefined)).toBe(true);
  expect(decision.unread(message(1), channel, undefined)).toBe(false);
  coverage
    .mockResolvedValueOnce({ messages: { [id(2)]: "read" }, read_revision: 8 })
    .mockResolvedValueOnce({
      messages: { [id(2)]: "unread" },
      read_revision: 9,
    });
  expect(decision.unread(message(2), channel, undefined)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(20);
  expect(decision.unread(message(2), channel, undefined)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(coverage).toHaveBeenCalledTimes(2);
  expect(decision.unread(message(2), channel, undefined)).toBe(true);
  // A reply in a thread the relay does not list is read.
  expect(decision.unread(reply(12), channel, root)).toBe(false);
  api.dispose();
});

it("sends mark_through for viewed mentions and unread catch-up only", async () => {
  const { api, unread, events, attention, write } = setup({
    channel_id: channel,
    unread: true,
    mentions: 1,
    read_through_id: id(1),
    latest_id: id(3),
    threads: [],
  });
  await api.load();
  for (const event of [message(2), message(3, [["p", viewer]])])
    events.set(event.id, event);
  attention.set(id(2), { unread: true, mentioned: false });
  attention.set(id(3), { unread: true, mentioned: true });
  const reading = unread.reading(channel);
  await reading.observe([id(2), id(3)]);
  await vi.advanceTimersByTimeAsync(150);
  expect(write.mock.calls.at(-1)?.[0]).toEqual([
    {
      type: "mark_through",
      target: { channel_id: channel },
      message_id: id(3),
    },
  ]);
  expect(api.row(channel)).toMatchObject({ unread: false, mentions: 0 });
  // Already read: catching up again writes nothing.
  const writes = write.mock.calls.length;
  await reading.catchUp(id(3));
  await vi.advanceTimersByTimeAsync(150);
  expect(write.mock.calls.length).toBe(writes);
  api.dispose();
});

it("sends follow and unfollow intents", async () => {
  const { api, unread, write } = setup({
    channel_id: channel,
    unread: false,
    mentions: 0,
    read_through_id: id(1),
    latest_id: id(1),
    threads: [],
  });
  await api.load();
  unread.follow(channel, root, false);
  await vi.advanceTimersByTimeAsync(150);
  expect(write.mock.calls.at(-1)?.[0]).toEqual([
    { type: "unfollow", target: { channel_id: channel, root_id: root } },
  ]);
  api.dispose();
});

it("a thread stays followed after it is read, until unfollowed", async () => {
  const { api, unread } = setup({
    channel_id: channel,
    unread: false,
    mentions: 0,
    read_through_id: id(1),
    latest_id: id(1),
    threads: [
      {
        root_id: root,
        unread: true,
        mentions: 1,
        read_through_id: null,
        latest_id: id(11),
      },
    ],
  });
  await api.load();
  expect(unread.following(channel, root)).toBe(true);
  api.readLocally(channel, root, id(11));
  expect(api.row(channel)?.threads).toEqual([]);
  expect(unread.following(channel, root)).toBe(true);
  unread.follow(channel, root, false);
  expect(unread.following(channel, root)).toBe(false);
  api.dispose();
});

it("asks coverage once for a broadcast reply that sits in two scopes", async () => {
  const coverage = vi.fn<NonNullable<ReadApiHost["coverage"]>>(async (ids) => ({
    messages: Object.fromEntries(ids.map((one) => [one, "unread"])),
  }));
  const { api, decision } = setup(
    {
      channel_id: channel,
      unread: true,
      mentions: 0,
      read_through_id: id(1),
      latest_id: id(4),
      threads: [
        {
          root_id: root,
          unread: true,
          mentions: 0,
          read_through_id: id(11),
          latest_id: id(14),
        },
      ],
    },
    coverage,
  );
  await api.load();
  const both = message(12, [
    ["e", root, "", "reply"],
    ["broadcast", "1"],
  ]);
  expect(decision.unread(both, channel, root)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(20);
  expect(decision.unread(both, channel, root)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(coverage).toHaveBeenCalledTimes(1);
  expect(coverage.mock.calls[0]?.[0]).toEqual([id(12)]);
  api.dispose();
});

it("sends no mark for a message whose scope it cannot tell", async () => {
  const { api, unread, write } = setup({
    channel_id: channel,
    unread: true,
    mentions: 0,
    read_through_id: id(1),
    latest_id: id(3),
    threads: [],
  });
  await api.load();
  await unread.markMessageRead(channel, id(3));
  await vi.advanceTimersByTimeAsync(150);
  expect(write).not.toHaveBeenCalled();
  api.dispose();
});

it("asks no coverage again when a later message arrives", async () => {
  const coverage = vi.fn<NonNullable<ReadApiHost["coverage"]>>(async (ids) => ({
    messages: Object.fromEntries(ids.map((one) => [one, "unread"])),
  }));
  const { api, decision } = setup(
    {
      channel_id: channel,
      unread: true,
      mentions: 0,
      read_through_id: id(1),
      latest_id: id(4),
      threads: [],
    },
    coverage,
  );
  await api.load();
  expect(decision.unread(message(2), channel, undefined)).toBeUndefined();
  expect(decision.unread(message(4), channel, undefined)).toBe(true);
  await vi.advanceTimersByTimeAsync(20);
  expect(coverage).toHaveBeenCalledTimes(1);
  api.observe(message(5));
  expect(decision.unread(message(2), channel, undefined)).toBe(true);
  // The replaced latest stays unread under the same anchor.
  expect(decision.unread(message(4), channel, undefined)).toBe(true);
  // Shown before its row caught up: the arrival is the latest by the time
  // the batch goes out.
  expect(decision.unread(message(6), channel, undefined)).toBeUndefined();
  api.observe(message(6));
  await vi.advanceTimersByTimeAsync(100);
  expect(decision.unread(message(6), channel, undefined)).toBe(true);
  expect(coverage).toHaveBeenCalledTimes(1);
  api.dispose();
});

it("keeps a message read once its scope's anchor moves on", async () => {
  const coverage = vi.fn<NonNullable<ReadApiHost["coverage"]>>(async (ids) => ({
    messages: Object.fromEntries(ids.map((one) => [one, "read"])),
  }));
  const { api, decision } = setup(
    {
      channel_id: channel,
      unread: true,
      mentions: 0,
      read_through_id: id(3),
      latest_id: id(4),
      threads: [],
    },
    coverage,
  );
  await api.load();
  expect(decision.unread(message(2), channel, undefined)).toBeUndefined();
  expect(decision.unread(message(3), channel, undefined)).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  expect(coverage).toHaveBeenCalledTimes(1);
  // Read through an own post, then another arrival: the anchor moved.
  api.observe({ ...message(5), pubkey: viewer });
  api.observe(message(6));
  expect(api.row(channel)).toMatchObject({
    unread: true,
    read_through_id: id(5),
  });
  for (const n of [2, 3])
    expect(decision.unread(message(n), channel, undefined)).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(coverage).toHaveBeenCalledTimes(1);
  api.dispose();
});
