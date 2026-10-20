import { knownAgentPubkeys } from "../agents/known";
import type { ComposerSession } from "./composer-session";
import { archivedMention } from "./mention-admission";
import { followupDraft, type MentionDraft } from "./mention-draft";
import { rememberAgentsPreference } from "./mention-preferences";

/** The next scoped draft remembers only exact agents notified by the sent message. */
export function rememberedMentions(
  session: ComposerSession,
  draft: MentionDraft,
  notified: readonly string[],
): MentionDraft {
  const agents = knownAgentPubkeys(
    session.profiles.snapshot(),
    session.agentChoices.snapshot(),
  );
  return followupDraft(
    rememberAgentsPreference()
      ? draft.recipients.filter(
          (item) =>
            agents.has(item.pubkey) &&
            notified.includes(item.pubkey) &&
            !archivedMention(session, item.pubkey),
        )
      : [],
  );
}
