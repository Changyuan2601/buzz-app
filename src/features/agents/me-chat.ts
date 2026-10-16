import type { ChannelSummary } from "../relay/contracts";
import type { RelayData } from "../relay/service";

/** Exact owner/agent DM evidence from the current relay-signed roster.
 * Group DMs, cached/unknown membership and unwritable channels do not count. */
export function ownerDm(
  channel: ChannelSummary | undefined,
  owner: string,
  self: string | undefined,
) {
  return (
    !!self &&
    self !== owner &&
    channel?.channelType === "dm" &&
    !channel.archived &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.parentChannelId &&
    channel.members?.length === 2 &&
    channel.members.includes(owner) &&
    channel.members.includes(self)
  );
}

/** Whether an agent answers at the top level of its owner's Solo chat or exact
 * one-to-one DM. Group DMs retain their existing routing. Unreadable Solo
 * placement is unknown, not Messages; callers freeze the policy per turn. */
export async function meChat(
  relay: () => RelayData | undefined,
  owner: string,
  channelId: string,
  signal: AbortSignal,
  self?: string,
) {
  const snapshot = relay()?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return false;
  const { session, scope } = snapshot;
  const channel =
    session.channels.list().channels.find((row) => row.id === channelId) ??
    session.channels.get?.(channelId);
  if (channel?.channelType === "dm") return ownerDm(channel, owner, self);
  const placement = session.mePlacement;
  const status = () => placement.snapshot().status;
  if (status() === "unavailable") return false;
  if (status() !== "ready") await placement.refresh();
  signal.throwIfAborted();
  const after = relay()?.snapshot();
  if (
    after?.status !== "ready" ||
    after.session !== session ||
    after.scope !== scope ||
    after.viewer !== owner
  )
    throw new Error(
      "The community changed before this was answered. Try again.",
    );
  if (status() !== "ready")
    throw new Error(
      `Couldn't read your Solo chats to tell where to answer (${placement.snapshot().error ?? "not loaded"}). Try again.`,
    );
  return placement.has(channelId);
}
