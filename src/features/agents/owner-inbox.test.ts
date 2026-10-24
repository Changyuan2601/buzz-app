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
    authorId: "b".repeat(64),
    preview: `in ${channelId}`,
    createdAt: 100,
    mentioned: false,
    thread: false,
    unreadCount: 0,
    ...fields,
  }) as InboxItem;

function session({
  failed = false,
  status = "ready" as "ready" | "loading",
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
    }),
  ];
  const ensure = vi.fn(async () => {
    if (failed) throw new Error("offline");
  });
  const feedEnsure = vi.fn(async () => undefined);
  return {
    ensure,
    feedEnsure,
    session: {
      channels: { list: () => ({ status: "ready", channels }) },
      unread: {
        ensure,
        inbox: () => ({ status, items, freshness: "observed" }),
      },
      inboxFeed: {
        ensure: feedEnsure,
        snapshot: () => ({ status: "ready", incomplete: [] }),
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
    mentioned: false,
    thread: false,
    unread: 0,
  });
  expect(inbox.items[2]).toMatchObject({
    root: "r".repeat(64),
    message: "p".repeat(64),
    mentioned: true,
    thread: true,
    unread: 3,
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
