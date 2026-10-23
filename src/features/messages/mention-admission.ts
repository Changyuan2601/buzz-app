import type { ChannelSummary } from "../relay/contracts";
import type { ComposerSession } from "./composer-session";
import type { MentionRecipient } from "./mention-draft";
import { archiveHides } from "../relay/identity-archives";

/** The shared archive discovery rule applied to mention recipients. */
export function archivedMention(session: ComposerSession, pubkey: string) {
  return archiveHides(session.archives, pubkey, session.viewer);
}

/**
 * Whether a destination can name people outside it from the community
 * directory. A Solo chat composer in Solo mode (agent invitation or the
 * owner's roster) can, so its people can reference anyone; it never adds
 * them. Other Solo chat composers, such as media comments and edits, keep
 * their members-only choices. Other known channels can unless a closed draft
 * roster or agent invitation limits the choices. Delivery decides what an
 * outside key becomes: an added member, or a reference that notifies nobody.
 */
export function allowsOutsideMentions(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
  roster?: readonly MentionRecipient[],
  inviteAgents = false,
) {
  if (!channel) return false;
  return channel.channelType === "solo"
    ? !!roster || inviteAgents
    : !roster && !inviteAgents;
}

/**
 * Whether sending a mention of this outside key adds it to the destination.
 * A Solo chat adds only the viewer's agents; a DM adds nobody. There, any
 * other outside key becomes a reference without a prompt.
 */
export function invitesOutsideMention(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
  agents: readonly { pubkey: string }[],
  pubkey: string,
) {
  if (channel?.channelType === "dm") return false;
  if (channel?.channelType === "solo")
    return agents.some((agent) => agent.pubkey === pubkey);
  return true;
}

/**
 * Which keys a draft may address in this destination, read once from current
 * state. The host owns this rule; the mentions plugin offers a subset of it and
 * owns its order and labels. Delivery checks membership again and asks before
 * addressing outside people.
 */
export function mentionAdmission(
  session: ComposerSession,
  channelId: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
): (pubkey: string) => boolean {
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  if (channel?.archived || channel?.readOnly) return () => false;
  const allowed = roster
    ? new Set(roster.map((person) => person.pubkey))
    : new Set(channel?.members);
  if (!roster && inviteAgents && channel?.channelType !== "dm")
    for (const agent of session.agentChoices.snapshot().identities)
      allowed.add(agent.pubkey);
  // A roster leaves out some members on purpose; naming outside people must
  // not admit them again. Unknown membership leaves no outside keys then.
  const members = roster ? channel?.members : undefined;
  const outside = (pubkey: string) =>
    allowsOutsideMentions(channel, roster, inviteAgents) &&
    (!roster || (!!members && !members.includes(pubkey)));
  return (pubkey) =>
    /^[0-9a-f]{64}$/.test(pubkey) &&
    !archivedMention(session, pubkey) &&
    (allowed.has(pubkey) || outside(pubkey));
}

/**
 * The recipient a pasted identity link adds, under its current name, or null.
 * The pasted label is never the name: it could disguise the invitee. A key
 * with no known name is accepted only if it is a member; otherwise the link
 * stays display-only, as the chooser would not offer it.
 */
export function pastedMentionRecipient(
  session: ComposerSession,
  channelId: string,
  pubkey: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
): MentionRecipient | null {
  if (!mentionAdmission(session, channelId, inviteAgents, roster)(pubkey))
    return null;
  const listed = roster?.find((person) => person.pubkey === pubkey);
  const name =
    session.profiles.snapshot().get(pubkey)?.name ||
    listed?.name ||
    session.agentChoices
      .snapshot()
      .identities.find((agent) => agent.pubkey === pubkey)?.name;
  if (name) return { pubkey, name };
  const member = roster
    ? !!listed
    : !!session.channels
        .list()
        .channels.find((c) => c.id === channelId)
        ?.members?.includes(pubkey);
  return member ? { pubkey, name: pubkey.slice(0, 12) } : null;
}
