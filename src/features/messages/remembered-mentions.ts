import { knownAgentPubkeys } from "../agents/known";
import type { ChannelMessage } from "../relay/contracts";
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

/** A composer with nothing saved starts with the agents the viewer's latest
 * message in its conversation notified, under their current known names:
 * relay history, not a saved draft, so every device derives the same prefill.
 * Classification matches rememberedMentions; a key with no known name is
 * skipped, since a mention span must read `@Name`. */
export function seedMentions(
  session: ComposerSession,
  seed: Pick<ChannelMessage, "mentions">,
): MentionDraft {
  const profiles = session.profiles.snapshot();
  const choices = session.agentChoices.snapshot().identities;
  const candidates = [...new Set(seed.mentions)].flatMap((pubkey) => {
    const name =
      profiles.get(pubkey)?.name ??
      choices.find((agent) => agent.pubkey === pubkey)?.name;
    return name ? [{ pubkey, name }] : [];
  });
  return rememberedMentions(session, followupDraft(candidates), seed.mentions);
}

/** Whether the evidence classifying a message's tagged keys has settled: the
 * agent inventory is complete and every key has a profile or an identity. A
 * seed taken earlier may name a subset of the agents, so a composer keeps it
 * provisional until then. */
export function seedEvidenceSettled(
  session: ComposerSession,
  seed: Pick<ChannelMessage, "mentions">,
): boolean {
  const choices = session.agentChoices.snapshot();
  if (!choices.complete) return false;
  const profiles = session.profiles.snapshot();
  return seed.mentions.every(
    (pubkey) =>
      profiles.has(pubkey) ||
      choices.identities.some((agent) => agent.pubkey === pubkey),
  );
}

/** The viewer's latest top-level message in a channel window: the seed for a
 * channel, Huddle, DM or Solo composer. Replies seed their thread instead. */
export function latestOwnMessage(
  viewer: string,
  rows: readonly ChannelMessage[],
): ChannelMessage | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row && row.authorId === viewer && !row.threadRootId) return row;
  }
}
