import { useCallback, useSyncExternalStore } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { MentionRecipient } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";
import { readView, subscribeView, writeView } from "../../shared/view-state";

// Saved on this device for the account and community (the view scope).
const KEY = "me:default-agent";

/** Makes an agent the one new Berd messages are tagged for. */
export function setDefaultAgent(scope: string, pubkey: string) {
  return writeView(scope, KEY, /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null);
}

function useChosenAgent(scope: string) {
  return useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () => {
      const value = readView<unknown>(scope, KEY, null);
      return typeof value === "string" ? value : undefined;
    },
  );
}

/**
 * The agent new Berd messages are tagged for: the one chosen as default when
 * it can still be tagged, otherwise the first agent the viewer runs here, else
 * the first agent they can tag. Bestie may own this choice later. A requested
 * agent, as when search opens a new chat with it, replaces that choice: it is
 * tagged once it can be, and no other agent stands in for it.
 */
export function useDefaultAgent(
  session: RelaySession,
  scope: string,
  requested?: string,
): MentionRecipient | undefined {
  const chosen = useChosenAgent(scope);
  // The same evidence the Berd composer's mention roster reads.
  const choices = useAgentChoices(session, true, true);
  const fallbackReady =
    !requested &&
    choices.complete &&
    choices.archives.status !== "idle" &&
    choices.archives.status !== "loading";
  const agent =
    choices.selectable.find(
      (choice) => choice.pubkey === (requested ?? chosen),
    ) ??
    (fallbackReady
      ? (choices.selectable.find((choice) => choice.managed) ??
        choices.selectable[0])
      : undefined);
  return agent
    ? { pubkey: agent.pubkey, name: agent.managedName ?? agent.name }
    : undefined;
}
