import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { MentionRecipient } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";
import {
  clearViewValue,
  readView,
  subscribeView,
  writeView,
} from "../../shared/view-state";

// Saved on this device for the account and community (the view scope).
const KEY = "solo:default-agent";

const PUBKEY = /^[0-9a-f]{64}$/;

/** Makes an agent the one new Berd messages are tagged for. */
export function setDefaultAgent(scope: string, pubkey: string) {
  return writeView(scope, KEY, PUBKEY.test(pubkey) ? pubkey : null);
}

/** A deleted agent stops being the main agent everywhere it was chosen; the
 * next available one takes over and is saved. */
export function forgetDefaultAgent(pubkey: string) {
  clearViewValue(KEY, pubkey);
}

/** The saved main-agent selection, whether chosen by the person or initialized by
 * default selection. Read `useDefaultAgent` for the recipient of a new chat. */
export function readDefaultAgent(scope: string) {
  const value = readView<unknown>(scope, KEY, null);
  return typeof value === "string" && PUBKEY.test(value) ? value : undefined;
}

export function useChosenAgent(scope: string) {
  return useSyncExternalStore(
    useCallback((notify: () => void) => subscribeView(scope, notify), [scope]),
    () => readDefaultAgent(scope),
  );
}

/**
 * The agent new Berd messages are tagged for. A chosen main agent stays chosen
 * for as long as it exists, even when its runtime is signed out or broken, so
 * a failure shows on the agent the viewer expects. Without a choice, or once
 * the chosen agent is deleted (archived), the first agent the viewer runs
 * here, else the first they can tag, becomes the main agent and is saved so
 * it doesn't shift between loads. A chosen agent missing for another reason
 * is stood in for without replacing the choice. The pinned main-agent DM shares this saved
 * selection, not a temporary stand-in. A requested agent, as when search opens a new chat with it, replaces
 * that choice: it is tagged once it can be, and no other agent stands in for
 * it.
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
  const picked = choices.selectable.find(
    (choice) => choice.pubkey === (requested ?? chosen),
  );
  const fallback =
    !picked && fallbackReady
      ? (choices.selectable.find((choice) => choice.managed) ??
        choices.selectable[0])
      : undefined;
  const replaces =
    !!fallback &&
    (chosen === undefined || choices.archives.archived.includes(chosen));
  useEffect(() => {
    if (replaces && fallback) setDefaultAgent(scope, fallback.pubkey);
  }, [replaces, fallback, scope]);
  const agent = picked ?? fallback;
  return agent
    ? { pubkey: agent.pubkey, name: agent.managedName ?? agent.name }
    : undefined;
}
