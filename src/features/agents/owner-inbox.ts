// The owner's Inbox as an agent may see it: the conversations Inbox lists,
// read through the owner's session, kept to channels the agent is in or that
// are public. DMs never leave the owner's device this way, and neither does a
// private channel the agent cannot read itself.
import type { OwnerInbox } from "../../buzz-mcp/client";
import type { InboxItem } from "../relay/inbox";
import type { RelaySession } from "../relay/session";

export async function ownerInbox(
  session: Pick<RelaySession, "unread" | "inboxFeed" | "channels">,
  agent: string,
): Promise<OwnerInbox> {
  // Inbox loads when its page opens; an agent may ask first.
  const loaded = await Promise.allSettled([
    session.unread.ensure(),
    session.inboxFeed.ensure(),
  ]);
  const list = session.channels.list();
  const channels = new Map(
    list.channels
      .filter(
        (channel) =>
          channel.channelType !== "dm" &&
          (channel.members?.includes(agent) ||
            (channel.visibility === "public" && !channel.private)),
      )
      .map((channel) => [channel.id, channel]),
  );
  const inbox = session.unread.inbox();
  const feed = session.inboxFeed.snapshot();
  const failed = loaded.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )?.reason;
  const error =
    inbox.error ??
    feed.error ??
    (failed === undefined
      ? undefined
      : failed instanceof Error
        ? failed.message
        : String(failed));
  return {
    partial:
      !!error ||
      list.status !== "ready" ||
      list.coverage === "partial" ||
      inbox.status !== "ready" ||
      feed.status !== "ready",
    ...(error ? { error } : {}),
    items: inbox.items.flatMap((item) => {
      const channel = channels.get(item.channelId);
      if (!channel) return [];
      // The message a projection shows, as its Inbox row does.
      const shown = (row: InboxItem) => ({
        ...(row.rootId ? { root: row.rootId } : {}),
        message: row.previewMessageId ?? row.latestMessageId,
        author: row.authorId,
        preview: row.preview,
        createdAt: row.createdAt,
      });
      return [
        {
          channel: channel.id,
          channelName: channel.name,
          ...shown(item),
          thread: item.thread,
          unread: item.unreadCount,
          manual: item.manual,
          ...(item.mention ? { mention: shown(item.mention) } : {}),
        },
      ];
    }),
  };
}
