import { separateChatCards } from "../messages/chat-cards";
import { messageLinkParts } from "../messages/message-link-parts";
import { parseBuzzLink } from "../navigation/buzz-links";
import type { ChannelMessage } from "../relay/contracts";
import type { EventData } from "../relay/events";

export const SHARED_CHAT_TOPIC = "buzz.shared-session.v1";

/** Use exactly the card renderer's exclusions for quoted, code and hidden links. */
export function chatReferenceIds(content: string): string[] {
  const { cards } = separateChatCards({ content } as ChannelMessage, []);
  return [
    ...new Set(
      cards.flatMap((card) =>
        messageLinkParts(card.content).flatMap((part) => {
          const target = part.url && parseBuzzLink(part.url);
          return target &&
            target.format === "legacy" &&
            !target.messageId &&
            !target.threadRootId
            ? [target.channelId]
            : [];
        }),
      ),
    ),
  ];
}

/** Deliberate share intent, never inferred for ordinary sent text or old receipts. */
export function sharedChatTags(
  content: string,
  ids: readonly string[],
): string[][] {
  if (!ids.length) return [];
  const actual = new Set(chatReferenceIds(content));
  const unique = [...new Set(ids)];
  if (unique.length > 32 || unique.some((id) => !actual.has(id)))
    throw new Error("Shared chat references do not match the message.");
  return [["t", SHARED_CHAT_TOPIC], ...unique.map((id) => ["s", id])];
}

/** Explicit shares and historical visible chat cards, intersected with current text. */
export function sharedChatIds(
  event: EventData,
  content = event.content,
): string[] {
  if (
    event.kind !== 9 ||
    event.tags.filter(([key]) => key === "h").length !== 1
  )
    return [];
  const actual = new Set(chatReferenceIds(content));
  const marked = event.tags.some(
    ([key, value]) => key === "t" && value === SHARED_CHAT_TOPIC,
  );
  // Older cards have no structured marker. Their original signed visible card
  // supplies the association; an edit may remove it, but cannot add a new source.
  const original = marked
    ? event.tags.flatMap(([key, value]) =>
        key === "s" && value ? [value] : [],
      )
    : chatReferenceIds(event.content);
  return [...new Set(original)].slice(0, 32).filter((id) => actual.has(id));
}
