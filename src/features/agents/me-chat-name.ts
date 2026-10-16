import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { profileMentionParts } from "../messages/profile-mentions";
import { profileKey } from "../profiles/target";
import type { DraftRecipient } from "../messages/mention-draft";
import { SESSION_NAMED_LABEL } from "../sessions/metadata";
import { startingChatTitle } from "../sessions/chat-title";

/**
 * Names the owner's Me chat with an agent harness's own title, once. Only a
 * chat that still has its original first-message name is renamed. The first
 * tagged harness on that message names it, regardless of retry wording. A chat
 * renamed by anyone, including by this, is never touched again. The owner's
 * session renames it, as the owner would.
 */
export async function nameMeChat(
  relay: RelayData | undefined,
  owner: string,
  agent: string,
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
  const current = () => {
    const latest = relay?.snapshot();
    return (
      latest?.status === "ready" &&
      latest.viewer === owner &&
      latest.session === session &&
      session.mePlacement.has(channel)
    );
  };
  // Naming is for a new chat, not an unbounded history scan. A full page cannot
  // establish the first message, so keep the existing title rather than guess.
  const limit = 100;
  const history = await session.read([
    {
      kinds: [9],
      authors: [owner],
      "#h": [channel],
      top_level: true,
      until: event.created_at,
      limit,
      consistency: "strong",
    },
  ]);
  if (
    !current() ||
    history.length >= limit ||
    // session.read also merges the local outbox; an unsent event cannot be
    // evidence of the chat's original published message.
    history.some(
      (message) =>
        message.delivery !== undefined &&
        message.delivery !== "accepted" &&
        message.delivery !== "seen",
    )
  )
    return;
  const messages = history
    .filter(
      (message) =>
        message.kind === 9 &&
        message.pubkey === owner &&
        message.created_at <= event.created_at &&
        !threadReference(message) &&
        message.tags.some(([key, value]) => key === "h" && value === channel),
    )
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const original = messages[0];
  // Same-second messages do not prove authoring order. Do not choose a winner.
  if (
    !original ||
    messages[1]?.created_at === original.created_at ||
    original.tags.find(([tag]) => tag === "p")?.[1] !== agent
  )
    return;
  const recipients: DraftRecipient[] = [];
  let offset = 0;
  for (const part of profileMentionParts(
    {
      content: original.content,
      mentions: original.tags
        .filter(([key]) => key === "p")
        .map((tag) => tag[1] ?? ""),
    },
    session.profiles.snapshot(),
    session.agentChoices.snapshot().identities,
  )) {
    const pubkey = part.target && profileKey(part.target);
    if (pubkey)
      recipients.push({
        pubkey,
        name: part.text.slice(1),
        start: offset,
        end: offset + part.text.length,
      });
    offset += part.text.length;
  }
  const initial = startingChatTitle({ text: original.content, recipients });
  const base = await details.load(channel);
  if (
    !current() ||
    !base.canEdit ||
    base.labels?.includes(SESSION_NAMED_LABEL) ||
    base.name === name ||
    canonicalDetailsName(base.name) !== initial
  )
    return;
  await details.save(base, { ...base, name });
}
