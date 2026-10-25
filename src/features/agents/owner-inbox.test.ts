import { expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import type { InboxItem } from "../relay/inbox";
import { ownerInbox } from "./owner-inbox";

const owner = "0".repeat(64);
const agent = "a".repeat(64);
const channel = (id: string, fields: Partial<ChannelSummary> = {}) =>
  ({ id, name: id, members: [owner], ...fields }) as ChannelSummary;
const item = (channelId: string, fields: Partial<InboxItem> = {}) =>
  ({
    id: `${channelId}:x`,
    channelId,
    messageId: "m0",
    latestMessageId: `${channelId}-latest`,
    messageIds: [],
    authorId: "b".repeat(64),
    preview: `in ${channelId}`,
    createdAt: 100,
    mentioned: false,
    thread: false,
    unreadCount: 0,
    manual: false,
    ...fields,
  }) as InboxItem;

function session({
  failed = false,
  status = "ready" as "ready" | "loading" | "error",
  feed = { status: "ready", incomplete: [] } as {
    status: "ready" | "loading" | "error";
    incomplete: string[];
  },
} = {}) {
  const channels = [
    channel("joined", { members: [owner, agent], private: true }),
    channel("public", { visibility: "public" }),
    channel("private", { visibility: "private", private: true }),
    channel("unknown"),
    channel("flagged", { visibility: "public", private: true }),
    channel("dm", { channelType: "dm", members: [owner, agent] }),
  ];
  const items = [
    ...channels.map((each) => item(each.id)),
    item("gone"),
    item("public", {
      rootId: "r".repeat(64),
      previewMessageId: "p".repeat(64),
      mentioned: true,
      thread: true,
      unreadCount: 3,
      manual: true,
      messageIds: ["p".repeat(64), "q".repeat(64)],
      mention: item("public", {
        rootId: "r".repeat(64),
        latestMessageId: "q".repeat(64),
        messageIds: ["q".repeat(64)],
        authorId: "c".repeat(64),
        preview: "the mention",
        createdAt: 90,
      }),
    }),
  ];
  const ensure = vi.fn(async () => {
    if (failed) throw new Error("offline");
  });
  const refresh = vi.fn(async () => {
    status = "ready";
  });
  const feedEnsure = vi.fn(async () => undefined);
  const feedRefresh = vi.fn(async () => {
    feed = { status: "ready", incomplete: [] };
  });
  return {
    ensure,
    refresh,
    feedEnsure,
    feedRefresh,
    session: {
      channels: { list: () => ({ status: "ready", channels }) },
      unread: {
        ensure,
        refresh,
        inbox: () => ({ status, items, freshness: "observed" }),
      },
      inboxFeed: {
        ensure: feedEnsure,
        refresh: feedRefresh,
        snapshot: () => feed,
      },
    } as unknown as Parameters<typeof ownerInbox>[0],
  };
}

it("keeps the owner's Inbox to channels the agent is in or that are public", async () => {
  const { session: owned, ensure, feedEnsure } = session();
  const inbox = await ownerInbox(owned, agent);
  // An agent may ask before the owner ever opens Inbox.
  expect(ensure).toHaveBeenCalled();
  expect(feedEnsure).toHaveBeenCalled();
  expect(inbox.partial).toBe(false);
  expect(inbox.items.map((each) => each.channel)).toEqual([
    "joined",
    "public",
    "public",
  ]);
  expect(inbox.items[0]).toEqual({
    channel: "joined",
    channelName: "joined",
    message: "joined-latest",
    author: "b".repeat(64),
    preview: "in joined",
    createdAt: 100,
    thread: false,
    unread: 0,
    manual: false,
  });
  expect(inbox.items[2]).toMatchObject({
    root: "r".repeat(64),
    message: "p".repeat(64),
    thread: true,
    unread: 3,
    manual: true,
    mention: {
      root: "r".repeat(64),
      message: "q".repeat(64),
      author: "c".repeat(64),
      preview: "the mention",
      createdAt: 90,
      unread: 0,
      manual: false,
    },
  });
});

it("says the Inbox is partial when it has not all loaded", async () => {
  const failed = await ownerInbox(session({ failed: true }).session, agent);
  expect(failed).toMatchObject({ partial: true, error: "offline" });
  expect(failed.items).toHaveLength(3);
  const loading = await ownerInbox(
    session({ status: "loading" }).session,
    agent,
  );
  expect(loading.partial).toBe(true);
  expect(loading.error).toBeUndefined();
});

it("withholds previews whose edits or deletions have not loaded", async () => {
  const loading = await ownerInbox(
    session({ feed: { status: "loading", incomplete: ["q".repeat(64)] } })
      .session,
    agent,
  );
  // The pending mention is in both projections of its conversation.
  expect(loading.items[2]).toMatchObject({
    preview: "[Preview updating.]",
    mention: { preview: "[Preview updating.]" },
  });
  expect(loading.items[0]?.preview).toBe("in joined");
  expect(loading.partial).toBe(true);
  // Its retry fails too.
  const offline = session({
    feed: { status: "error", incomplete: ["p".repeat(64)] },
  });
  offline.feedRefresh.mockImplementation(async () => undefined);
  const failed = await ownerInbox(offline.session, agent);
  expect(failed.items[2]).toMatchObject({
    preview: "[Preview unavailable until Inbox loads.]",
    mention: { preview: "the mention" },
  });
});

it("retries a source that failed, and only that one", async () => {
  const errored = session({
    status: "error",
    feed: { status: "error", incomplete: ["q".repeat(64)] },
  });
  const inbox = await ownerInbox(errored.session, agent);
  expect(errored.refresh).toHaveBeenCalledTimes(1);
  expect(errored.feedRefresh).toHaveBeenCalledTimes(1);
  expect(errored.ensure).not.toHaveBeenCalled();
  expect(errored.feedEnsure).not.toHaveBeenCalled();
  expect(inbox.partial).toBe(false);
  expect(inbox.items[2]?.mention?.preview).toBe("the mention");
  // Once loaded, a later call only ensures.
  await ownerInbox(errored.session, agent);
  expect(errored.refresh).toHaveBeenCalledTimes(1);
  expect(errored.ensure).toHaveBeenCalledTimes(1);
});
