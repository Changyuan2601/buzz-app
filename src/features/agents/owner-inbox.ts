// The owner's Inbox as an agent may see it: the conversations Inbox lists,
// read through the owner's session, kept to channels the agent is in or that
// are public. DMs never leave the owner's device this way, and neither does a
// private channel the agent cannot read itself.
import type { OwnerInbox } from "../../buzz-mcp/client";
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
      return channel
        ? [
            {
              channel: channel.id,
              channelName: channel.name,
              ...(item.rootId ? { root: item.rootId } : {}),
              message: item.previewMessageId ?? item.latestMessageId,
              author: item.authorId,
              preview: item.preview,
              createdAt: item.createdAt,
              mentioned: item.mentioned,
              thread: item.thread,
              unread: item.unreadCount,
            },
          ]
        : [];
    }),
  };
}
