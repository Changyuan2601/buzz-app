import { afterEach, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { keypair, message, signed } from "./testing";
import { createUnread } from "./unread";

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

const viewer = keypair(),
  peer = keypair();

async function session() {
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: [{ id: "c", name: "C", members: [viewer.pubkey] }],
    }),
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
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer: viewer.pubkey,
  });
  owners.push(owner);
  return owner;
}

const reply = (
  key: typeof viewer,
  content: string,
  createdAt: number,
  root: RelayEvent,
  parent = root,
  tags: string[][] = [],
) =>
  message(key, "c", content, createdAt, [
    ["e", root.id, "", "root"],
    ["e", parent.id, "", "reply"],
    ...tags,
  ]);
const deletion = (key: typeof viewer, target: RelayEvent, createdAt: number) =>
  signed(key, {
    kind: 5,
    content: "",
    created_at: createdAt,
    tags: [
      ["e", target.id],
      ["h", "c"],
    ],
  });

it("indexes older pages exactly as rebuilding the evidence would", async () => {
  // History arrives newest first, as when scrolling back: replies before
  // their roots, a deletion before its target, and the viewer's own replies.
  const ownRoot = message(viewer, "c", "own root", 10);
  const peerRoot = message(peer, "c", "peer root", 11);
  const deleted = message(peer, "c", "deleted later", 12);
  const nested = reply(peer, "nested", 20, peerRoot);
  const plain = message(peer, "c", "plain", 32);
  const pages = [
    [
      reply(peer, "to own root", 40, ownRoot),
      reply(peer, "deep", 41, peerRoot, nested),
      deletion(peer, deleted, 42),
      message(peer, "c", "mention", 43, [["p", viewer.pubkey]]),
    ],
    [
      reply(viewer, "own reply", 30, peerRoot),
      reply(peer, "after own reply", 31, peerRoot),
      plain,
    ],
    [nested, message(peer, "c", "broadcast", 21, [["broadcast", "1"]])],
    [deleted],
    [ownRoot, peerRoot],
    // A live deletion of indexed evidence.
    [deletion(peer, plain, 50)],
  ];
  const appended = await session(),
    rebuilt = await session();
  const ids: string[] = [];
  for (const [index, page] of pages.entries()) {
    appended.accept(page);
    rebuilt.accept(page);
    // Purging nothing invalidates the whole index.
    rebuilt.purge();
    ids.push(...page.map((event) => event.id));
    const view = (owner: typeof appended) => {
      const unread = owner.capability;
      return {
        channel: unread.snapshot({ kind: "channel", channelId: "c" }),
        threads: [ownRoot, peerRoot, nested].map((root) =>
          unread.snapshot({ kind: "thread", channelId: "c", rootId: root.id }),
        ),
        messages: ids.map((id) => unread.attention("c", id)),
        activity: unread.activity("c"),
      };
    };
    // Leave one page unread before the next arrives.
    if (index !== 1) expect(view(appended)).toEqual(view(rebuilt));
  }
  expect(
    appended.capability.snapshot({
      kind: "thread",
      channelId: "c",
      rootId: peerRoot.id,
    }).observedCount,
  ).toBeGreaterThan(0);
});
