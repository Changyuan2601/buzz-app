import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { startingChatTitle } from "../sessions/chat-title";

/**
 * Names the owner's Me chat with an agent harness's own title, once. Only a
 * chat that still has its starting name (the message that triggered this
 * turn) is renamed, so the first harness to answer names it, and a chat
 * renamed by anyone, including by this, is never touched again. The owner's
 * session renames it, as the owner would.
 */
export async function nameMeChat(
  relay: RelayData | undefined,
  owner: string,
  event: RelayEvent,
  title: string,
) {
  const snapshot = relay?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return;
  const { session } = snapshot;
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channel || !session.mePlacement.has(channel)) return;
  const name = [...canonicalDetailsName(title.replace(/\s+/g, " "))]
    .slice(0, 120)
    .join("");
  const details = session.channelDetails;
  if (!name || !details.available) return;
  const base = await details.load(channel);
  if (
    !base.canEdit ||
    base.name === name ||
    canonicalDetailsName(base.name) !==
      canonicalDetailsName(startingChatTitle(event.content))
  )
    return;
  await details.save(base, { ...base, name });
}
