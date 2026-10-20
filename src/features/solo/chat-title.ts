import { stageSessionCards } from "../messages/composer-session-cards";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { canonicalDetailsName } from "../relay/channel-details-protocol";

/** Remove only structured leading recipient tags; literal @ text remains title content. */
export function startingChatTitle(value: MentionDraft | string): string {
  const draft = stageSessionCards(mentionDraft(value), []);
  // Match main’s caption-first title; cards remain the fallback for card-only sends.
  const text =
    composerMarkdown({ ...draft, sessionCards: [] }).trim() ||
    composerMarkdown(draft);
  let start = 0;
  let draftStart = 0;
  for (const recipient of [...draft.recipients].sort(
    (a, b) => a.start - b.start,
  )) {
    if (
      recipient.start < draftStart ||
      draft.text.slice(draftStart, recipient.start).trim()
    )
      break;
    const leading = text.slice(start).match(/^\s*/)?.[0].length ?? 0;
    const tag = `@${recipient.name}`;
    if (!text.startsWith(tag, start + leading)) break;
    start += leading + tag.length;
    draftStart = recipient.end;
  }
  return (
    canonicalDetailsName(
      [
        ...(
          text.slice(start).trim() || (draft.sessionCards ?? []).join("\n\n")
        ).replace(/\s+/g, " "),
      ]
        .slice(0, 80)
        .join(""),
    ) || "Chat"
  );
}
