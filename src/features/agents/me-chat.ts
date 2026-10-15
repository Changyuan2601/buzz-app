import type { RelayData } from "../relay/service";

/** Whether a native agent's mention continues its owner's Me chat: one
 * channel-scoped conversation that posts at channel top level. Only the
 * owner's own placement in the agent's community counts; another member's
 * filing never does. Verified ordinary channels (including converted sessions)
 * use channel routing even if another owner still has them filed in Me. Unknown
 * type/placement evidence retains the existing fail-on-unreadable behavior.
 * Callers freeze the answer for the turn it admits. */
export async function meChat(
  relay: () => RelayData | undefined,
  owner: string,
  channelId: string,
  signal: AbortSignal,
) {
  const snapshot = relay()?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return false;
  const { session, scope } = snapshot;
  const ordinary = () => {
    const channel = session.channels
      .list()
      .channels.find((row) => row.id === channelId);
    return (
      channel?.channelType === "dm" ||
      (!channel?.cached &&
        (channel?.channelType === "stream" || channel?.channelType === "forum"))
    );
  };
  signal.throwIfAborted();
  if (ordinary()) return false;
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
  if (ordinary()) return false;
  if (status() !== "ready")
    throw new Error(
      `Couldn't read your Solo chats to tell where to answer (${placement.snapshot().error ?? "not loaded"}). Try again.`,
    );
  return placement.has(channelId);
}
