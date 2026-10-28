import { afterEach, expect, it } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
import { matchesEvent } from "./projection";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import { keypair, message, signed, type Key } from "./testing";
import { createUnread } from "./unread";

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const viewer = keypair(),
  alice = keypair(),
  bob = keypair();
const people = [viewer, alice, bob];
const roster: readonly ChannelSummary[] = [
  { id: "c0", name: "Zero", members: [viewer.pubkey] },
  { id: "c1", name: "One", members: [viewer.pubkey] },
  { id: "c2", name: "Two", channelType: "dm", members: [viewer.pubkey] },
];
const channels: ChannelQueries = {
  list: () => ({ status: "ready" as const, channels: roster }),
  subscribeList: () => () => {},
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

/** Messages, replies (also across channels and to unloaded parents), edits
 * and deletions, in a random arrival order. */
function history(next: () => number) {
  const pick = <T>(values: readonly T[]) =>
    values[Math.floor(next() * values.length)] as T;
  const created: { event: RelayEvent; author: Key; rootId: string }[] = [];
  const events: RelayEvent[] = [];
  for (let i = 0; i < 64; i++) {
    const author = pick(people);
    const channelId = pick(roster).id;
    const at = 1_700_000_000 + Math.floor(next() * 200);
    const roll = next();
    if (roll < 0.08 && created.length) {
      const target = pick(created);
      events.push(
        signed(target.author, {
          kind: next() < 0.5 ? 5 : 9005,
          content: "",
          created_at: at,
          // Deletions naming their channel are retained before their target.
          tags: [
            ...(next() < 0.5 ? [["h", target.event.tags[0]?.[1] ?? ""]] : []),
            ["e", target.event.id],
          ],
        }),
      );
      continue;
    }
    if (roll < 0.14 && created.length) {
      const target = pick(created);
      events.push(
        signed(target.author, {
          kind: 40003,
          content: `edit ${i}`,
          created_at: at,
          tags: [
            ["h", target.event.tags[0]?.[1] ?? ""],
            ["e", target.event.id],
          ],
        }),
      );
      continue;
    }
    const tags: string[][] = [];
    if (next() < 0.25) tags.push(["p", viewer.pubkey]);
    if (next() < 0.1) tags.push(["broadcast", "1"]);
    if (next() < 0.1) tags.push(["audience", "agents"]);
    let rootId: string | undefined;
    if (roll < 0.55 && created.length) {
      const parent = pick(created);
      // Usually in the parent's channel; sometimes a foreign or unloaded one.
      const unloaded = next() < 0.1;
      const parentId = unloaded ? "f".repeat(63) + (i % 10) : parent.event.id;
      rootId = unloaded ? parentId : parent.rootId;
      tags.push(["e", rootId, "", "root"], ["e", parentId, "", "reply"]);
      const event = message(
        author,
        next() < 0.9 ? (parent.event.tags[0]?.[1] ?? channelId) : channelId,
        `reply ${i}`,
        at,
        tags,
      );
      created.push({ event, author, rootId });
      events.push(event);
      continue;
    }
    const event = message(author, channelId, `post ${i}`, at, tags);
    created.push({ event, author, rootId: event.id });
    events.push(event);
  }
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [events[i], events[j]] = [events[j] as RelayEvent, events[i] as RelayEvent];
  }
  return events;
}

/** Without a relay, lookups never answer, so every owner holds the same
 * undecided replies. */
async function owner(preloaded: ReadJournal, relay?: readonly RelayEvent[]) {
  let journal: ReadJournal | undefined = preloaded;
  const reader = {
    read: (filters: readonly ReadFilter[]) =>
      relay
        ? Promise.resolve(
            relay.filter((event) =>
              filters.some((filter) => matchesEvent(event, filter)),
            ),
          )
        : new Promise<never>(() => {}),
  };
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
  const unread = createUnread({
    reads,
    channels,
    reader,
    viewer: viewer.pubkey,
  });
  owners.push(unread);
  return unread;
}

/** Every projection the index feeds: counts, mention and thread attention,
 * thread activity, the latest message, and the Inbox. */
function observe(
  { capability: unread }: ReturnType<typeof createUnread>,
  events: readonly RelayEvent[],
) {
  const ids = events.map(({ id }) => id).sort();
  return roster.map(({ id: channelId }) => ({
    channel: unread.snapshot({ kind: "channel", channelId }),
    activity: unread.activity(channelId),
    messages: ids.map((messageId) => [
      unread.attention(channelId, messageId),
      unread.snapshot({ kind: "message", channelId, messageId }),
      unread.snapshot({ kind: "thread", channelId, rootId: messageId }),
    ]),
    inbox: unread.inbox(),
  }));
}

/** A seeded history, read-state frontiers over it, and its arrival batches:
 * pages first, then single live arrivals. */
function scenario(seed: number) {
  const next = random(seed);
  const events = history(next);
  const pick = () => events[Math.floor(next() * events.length)] as RelayEvent;
  const base = newReadJournal();
  const preloaded: ReadJournal = {
    ...base,
    state: {
      ...base.state,
      frontiers: {
        c0: 1_700_000_100,
        "activity:c1": 1_700_000_050,
        [`thread:${pick().id}`]: 1_700_000_150,
        [`msg:${pick().id}`]: 1_700_000_199,
      },
    },
  };
  const thread = pick();
  const row = pick();
  const batches: RelayEvent[][] = [];
  for (let i = 0; i < events.length; ) {
    const size = i < events.length / 2 ? 1 + Math.floor(next() * 8) : 1;
    batches.push(events.slice(i, i + size));
    i += size;
  }
  /** Subscribers make every accept publish through the folded index: a
   * channel, activity, the Inbox, an open thread and a row's message. */
  function listen({ capability: unread }: ReturnType<typeof createUnread>) {
    unread.subscribe({ kind: "channel", channelId: "c0" }, () => {});
    unread.subscribeActivity("c1", () => {});
    unread.subscribeInbox(() => {});
    unread.subscribe(
      {
        kind: "thread",
        channelId: thread.tags[0]?.[1] ?? "c0",
        rootId: thread.id,
      },
      () => {},
    );
    unread.subscribe(
      {
        kind: "message",
        channelId: row.tags[0]?.[1] ?? "c0",
        messageId: row.id,
      },
      () => {},
    );
  }
  return { events, preloaded, batches, listen };
}

const seeds = Array.from({ length: 24 }, (_, seed) => seed + 1);

it.each(seeds)(
  "folding accepted batches matches a rebuild from every retained event (seed %s)",
  async (seed) => {
    const { events, preloaded, batches, listen } = scenario(seed);
    const incremental = await owner(preloaded);
    listen(incremental);
    for (const [index, batch] of batches.entries()) {
      incremental.accept(batch);
      // A fresh owner indexes the same accepted history once, from scratch.
      const rebuilt = await owner(preloaded);
      for (const earlier of batches.slice(0, index + 1))
        rebuilt.accept(earlier);
      expect(observe(incremental, events)).toEqual(observe(rebuilt, events));
    }
  },
);

/** Lets every lookup the projections ask for finish. */
async function settle(
  unread: ReturnType<typeof createUnread>,
  events: readonly RelayEvent[],
) {
  for (let i = 0; i < 4; i++) {
    observe(unread, events);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

it.each(seeds)(
  "folding matches a rebuild while lookups decide memberships (seed %s)",
  async (seed) => {
    const { events, preloaded, batches, listen } = scenario(seed);
    // Lookups answer from the whole history. When they finish depends on
    // when projections ask, so the rebuilding twin runs in lockstep.
    const incremental = await owner(preloaded, events);
    const rebuilt = await owner(preloaded, events);
    listen(incremental);
    listen(rebuilt);
    // Any deletion in a batch invalidates the index, even one that is not
    // retained: this one names no channel and no retained message.
    const rebuild = signed(alice, {
      kind: 5,
      content: "",
      created_at: 1_700_000_000,
      tags: [["e", "0".repeat(64)]],
    });
    for (const batch of batches) {
      incremental.accept(batch);
      rebuilt.accept([rebuild]);
      rebuilt.accept(batch);
      await Promise.all([settle(incremental, events), settle(rebuilt, events)]);
      expect(observe(incremental, events)).toEqual(observe(rebuilt, events));
    }
  },
);
