import type { ChannelSummary } from "../../features/relay/contracts";

/** The viewer's one chat with their Bestie: the most recently active chat they
 * started whose only other member is that agent. Resolved from the relay-signed
 * roster instead of a stored channel id, so every device agrees on which chat
 * it is, and an unknown roster never stands in for a match. */
export function bestieChat(
  channels: readonly ChannelSummary[],
  viewer: string | undefined,
  bestie: string | undefined,
) {
  if (!viewer || !bestie) return;
  return channels
    .filter(
      (channel) =>
        channel.channelType === "solo" &&
        !channel.archived &&
        channel.creator === viewer &&
        onlyOther(channel.members, viewer) === bestie,
    )
    .sort(
      (a, b) =>
        recency(b) - recency(a) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .at(0);
}

const recency = (channel: ChannelSummary) =>
  channel.lastActivityAt ?? channel.createdAt ?? 0;

/** The one member who is not the viewer, or none: a chat shared with anyone
 * else is an ordinary chat, not this one. */
function onlyOther(members: readonly string[] | undefined, viewer: string) {
  if (!members) return;
  const others = [...new Set(members)].filter((key) => key !== viewer);
  return others.length === 1 ? others[0] : undefined;
}
