import type { RelaySession } from "../relay/session";
import { followupDraft } from "../messages/mention-draft";
import { rememberedMentions } from "../messages/remembered-mentions";

/** Exact legacy intent only: never substitute the account default or a namesake. */
export function legacyAssistantDraft(session: RelaySession, pubkey: string) {
  const agent = session.agentChoices
    .snapshot()
    .selectable.find((choice) => choice.pubkey === pubkey);
  const draft = followupDraft(
    agent ? [{ pubkey, name: agent.managedName ?? agent.name }] : [],
  );
  return rememberedMentions(session, draft, [pubkey]);
}
