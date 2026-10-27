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

// Cached on this device for the account and community (the view scope). A
// choice made in Agents is also saved to the account, which every install
// adopts once per session; automatic picks stay on the device, and nothing
// else ever writes the account's.
const KEY = "solo:default-agent";
type Account = NonNullable<RelaySession["mainAgent"]>;
const adopted = new WeakMap<Account, Promise<void>>();
// The account's saved choice once read: undefined when never saved or
// unreadable.
const saved = new WeakMap<Account, string | undefined>();
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
function remember(account: Account, agent: string | undefined) {
  saved.set(account, agent);
  notify();
}
function subscribeSaved(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// Counts each account's explicit choices, so adoption never overwrites a
// newer one.
const explicit = new WeakMap<Account, number>();
// Sessions whose archive evidence has arrived once. Until then a cached or
// adopted choice may name an agent deleted elsewhere; later reads, as on
// reconnect, don't hide it again. Watched for the session's lifetime, not
// only while a composer is mounted.
type Choices = RelaySession["agentChoices"];
const verified = new WeakSet<Choices>();
const watching = new WeakSet<Choices>();
function archivesRead(choices: ReturnType<Choices["snapshot"]>) {
  const { status } = choices.archives;
  return status !== "idle" && status !== "loading";
}
function verify(source: Choices) {
  if (verified.has(source) || watching.has(source)) return;
  watching.add(source);
  let stop: (() => void) | undefined;
  const check = () => {
    if (!archivesRead(source.snapshot())) return;
    verified.add(source);
    stop?.();
    notify();
  };
  stop = source.subscribe(check);
  check();
}

/** Makes an agent the one new Berd messages are tagged for, on this device. */
export function setDefaultAgent(scope: string, pubkey: string) {
  return writeView(scope, KEY, /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null);
}

/** The viewer's own choice: saved here, then to their account. */
export async function chooseDefaultAgent(
  session: RelaySession,
  scope: string,
  pubkey: string,
) {
  const account = session.mainAgent;
  if (account) explicit.set(account, (explicit.get(account) ?? 0) + 1);
  if (!setDefaultAgent(scope, pubkey))
    throw new Error("The main agent couldn't be saved on this device.");
  if (!account) return;
  try {
    await account.write(pubkey);
  } catch {
    throw new Error(
      "The main agent couldn't be saved to your account. Try again.",
    );
  }
  remember(account, pubkey);
}

/** A deleted agent stops being the main agent everywhere it was chosen; the
 * next available one takes over and is saved on this device. One left on the
 * account is stood in for like any deleted choice, until the next choice. */
export function forgetDefaultAgent(pubkey: string) {
  clearViewValue(KEY, pubkey);
}

/** Adopts the account's saved choice once per session. Settles even when the
 * read fails, so an offline install still gets a main agent. */
function adopt(account: Account, scope: string) {
  let pending = adopted.get(account);
  if (!pending) {
    const before = explicit.get(account);
    pending = account.read().then(
      (agent) => {
        // A choice made while reading is newer than the record read.
        if (explicit.get(account) !== before)
          return remember(account, saved.get(account));
        if (agent !== undefined) writeView(scope, KEY, agent);
        remember(account, agent);
      },
      () => {
        adopted.delete(account);
        remember(account, saved.get(account));
      },
    );
    adopted.set(account, pending);
  }
  return pending;
}

/** Whether the account's saved choice has been read (or couldn't be), and
 * what it is. */
function useAdopted(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  useEffect(() => {
    if (account) void adopt(account, scope);
  }, [account, scope]);
  const read = useSyncExternalStore(subscribeSaved, () =>
    account ? saved.has(account) : true,
  );
  const agent = useSyncExternalStore(subscribeSaved, () =>
    account ? saved.get(account) : undefined,
  );
  return { read, agent };
}

/** The agent saved as main on the viewer's account, when it has one; without
 * an account record, the agent saved on this device. */
export function useSavedAgent(session: RelaySession, scope: string) {
  const local = useChosenAgent(scope);
  const account = useAdopted(session, scope);
  return session.mainAgent ? account.agent : local;
}

/** The agent explicitly saved as main, whether or not it can be tagged now. */
export function useChosenAgent(scope: string) {
  return useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () => {
      const value = readView<unknown>(scope, KEY, null);
      return typeof value === "string" ? value : undefined;
    },
  );
}

/**
 * The agent new Berd messages are tagged for. A chosen main agent stays chosen
 * for as long as it exists, even when its runtime is signed out or broken, so
 * a failure shows on the agent the viewer expects. Without a choice, or once
 * the chosen agent is deleted (archived), and once the account's saved choice
 * has been read, the first agent the viewer runs here, else the first they
 * can tag, becomes the main agent and is saved on this device so it doesn't
 * shift between loads. A chosen agent missing for another reason
 * is stood in for without replacing the choice. Bestie may own this choice
 * later. A requested agent, as when search opens a new chat with it, replaces
 * that choice: it is tagged once it can be, and no other agent stands in for
 * it.
 */
export function useDefaultAgent(
  session: RelaySession,
  scope: string,
  requested?: string,
): MentionRecipient | undefined {
  const adoption = useAdopted(session, scope);
  const chosen = useChosenAgent(scope);
  // The same evidence the Berd composer's mention roster reads.
  const choices = useAgentChoices(session, true, true);
  const read = archivesRead(choices);
  const fallbackReady = !requested && adoption.read && choices.complete && read;
  // With an account, a choice cached here waits for the account's, and for the
  // session's first archive evidence, so a stale or deleted one is never
  // shown, or sent to, first.
  const source = session.agentChoices;
  useEffect(() => verify(source), [source]);
  const evidence = useSyncExternalStore(subscribeSaved, () =>
    verified.has(source),
  );
  const usable = adoption.read && (!session.mainAgent || read || evidence);
  const picked = choices.selectable.find(
    (choice) => choice.pubkey === (requested ?? (usable ? chosen : undefined)),
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
