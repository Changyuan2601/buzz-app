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

/** Who a Solo chat's toolbar holds before it has an audience, whatever the
 * remember-agents preference says. Waits for complete agent choices.
 *
 * Every agent the viewer's latest top-level message in the loaded window
 * tagged that can still be tagged. Without one: the main agent if it is a
 * member; else the first member agent that runs on this computer; else all the
 * chat's usable agent members; else the main agent. Once typed mentions have
 * replaced the remembered agents (`replaced`), the history is skipped. */
export function seedAgents(
  session: ComposerSession,
  channelId: string,
  rows: readonly ChannelMessage[],
  admits: (pubkey: string) => boolean,
  main?: string,
  replaced = false,
): readonly string[] {
  const choices = session.agentChoices.snapshot();
  if (!choices.complete) return [];
  const agents = knownAgentPubkeys(session.profiles.snapshot(), choices);
  const usable = (key: string) => agents.has(key) && admits(key);
  // After typed mentions replaced the remembered agents, the history is
  // skipped and the chat's own agents follow, the main agent first.
  for (let index = replaced ? -1 : rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row || row.authorId !== session.viewer || row.threadRootId) continue;
    const tagged = [...new Set(row.mentions.filter(usable))];
    if (tagged.length) return tagged;
  }
  const members = (
    session.channels.list().channels.find((item) => item.id === channelId)
      ?.members ?? []
  ).filter(usable);
  const mainMember = members.find((key) => key === main);
  if (mainMember) return [mainMember];
  const local = choices.selectable.find(
    (choice) => choice.managed && members.includes(choice.pubkey),
  );
  if (local) return [local.pubkey];
  if (members.length) return members;
  return main && admits(main) ? [main] : [];
}
