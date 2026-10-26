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

/** A thread composer opened with no saved draft starts with the agents the
 * viewer's latest message there notified, under their current known names.
 * Classification matches rememberedMentions; a key with no known name is
 * skipped, since a mention span must read `@Name`. */
export function threadSeedMentions(
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

/** The agent the viewer's latest top-level message in these rows tagged that
 * can still be tagged here. Off, like the follow-up draft, when agents aren't
 * remembered, and until agent choices are complete: a partial roster would
 * pick an older agent in place of the latest one. */
export function lastMentionedAgent(
  session: ComposerSession,
  rows: readonly ChannelMessage[],
  admits: (pubkey: string) => boolean,
): string | undefined {
  const choices = session.agentChoices.snapshot();
  if (!rememberAgentsPreference() || !choices.complete) return;
  const agents = knownAgentPubkeys(session.profiles.snapshot(), choices);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row || row.authorId !== session.viewer || row.threadRootId) continue;
    const agent = row.mentions.find((key) => agents.has(key) && admits(key));
    if (agent) return agent;
  }
}
