import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { ChannelSummary } from "../relay/contracts";
import type { MentionRecipient } from "../messages/mention-draft";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import {
  clearViewValue,
  readView,
  subscribeView,
  writeView,
} from "../../shared/view-state";

// Cached on this device for the account and community (the view scope), and
// saved to the account, which every install adopts once per session. While
// the account has none, the device's main agent is saved to it.
const KEY = "solo:default-agent";
type Account = NonNullable<RelaySession["mainAgent"]>;
const adopted = new WeakMap<Account, Promise<void>>();
// The account's saved choice once read: undefined when never saved or
// unreadable, null once cleared.
const saved = new WeakMap<Account, string | null | undefined>();
// Accounts whose record was read, so an empty one is known to be empty.
const readable = new WeakSet<Account>();
const claiming = new WeakSet<Account>();
const listeners = new Set<() => void>();
function remember(account: Account, agent: string | null | undefined) {
  saved.set(account, agent);
  for (const listener of listeners) listener();
}
function subscribeSaved(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// Counts each account's explicit choices, so adoption never overwrites a
// newer one.
const explicit = new WeakMap<Account, number>();

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
 * next available one takes over and is saved. */
export function forgetDefaultAgent(pubkey: string, session?: RelaySession) {
  clearViewValue(KEY, pubkey);
  // Best effort: a deleted agent left on the account is archived, and is
  // stood in for like any deleted choice.
  const account = session?.mainAgent;
  account
    ?.forget(pubkey)
    .then((agent) => {
      if (saved.get(account) === pubkey) remember(account, agent);
    })
    .catch(() => {});
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
        readable.add(account);
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

/** Saves this device's main agent to an account known to have none. One
 * saved meanwhile elsewhere is kept and adopted instead; a newer explicit
 * choice is queued after, so it still wins. */
function claim(account: Account, scope: string, pubkey: string) {
  if (!readable.has(account) || saved.get(account) || claiming.has(account))
    return;
  claiming.add(account);
  const before = explicit.get(account);
  account.claim(pubkey).then(
    (agent) => {
      claiming.delete(account);
      if (explicit.get(account) !== before) return;
      if (agent !== pubkey) writeView(scope, KEY, agent);
      remember(account, agent);
    },
    () => claiming.delete(account),
  );
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
  return session.mainAgent ? (account.agent ?? undefined) : local;
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
 * and Solo chat activity have been read, the agent in the viewer's most
 * recently active Solo chat, else the first agent they run here, else the
 * first they can tag, becomes the main agent and is saved on this device so
 * it doesn't shift between loads. While the account has no main agent, this
 * device's (chosen or picked, never a requested one or a stand-in) is saved
 * to it. A chosen agent missing for another reason
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
  const accountRead = adoption.read;
  const chosen = useChosenAgent(scope);
  // The same evidence the Berd composer's mention roster reads.
  const choices = useAgentChoices(session, true, true);
  const list = useChannelList(session.channels);
  const fallbackReady =
    !requested &&
    accountRead &&
    list.status !== "idle" &&
    list.status !== "loading" &&
    // Solo chats' activity is always read; with none there is none to wait for.
    list.activityStatus !== "loading" &&
    !(
      list.activityStatus === "idle" &&
      list.channels.some((channel) => channel.channelType === "solo")
    ) &&
    choices.complete &&
    choices.archives.status !== "idle" &&
    choices.archives.status !== "loading";
  // A choice cached here waits for the account's, so a stale one is never
  // shown, or sent to, first.
  const picked = choices.selectable.find(
    (choice) =>
      choice.pubkey === (requested ?? (accountRead ? chosen : undefined)),
  );
  const fallback =
    !picked && fallbackReady
      ? (recentSoloAgent(list.channels, choices.selectable) ??
        choices.selectable.find((choice) => choice.managed) ??
        choices.selectable[0])
      : undefined;
  const replaces =
    !!fallback &&
    (chosen === undefined || choices.archives.archived.includes(chosen));
  useEffect(() => {
    if (replaces && fallback) setDefaultAgent(scope, fallback.pubkey);
  }, [replaces, fallback, scope]);
  // The device's own main agent, not a requested or stand-in one.
  const own = requested
    ? undefined
    : (picked?.pubkey ?? (replaces ? fallback?.pubkey : undefined));
  const account = session.mainAgent;
  const empty = adoption.agent == null;
  useEffect(() => {
    if (account && own && empty) claim(account, scope, own);
  }, [account, scope, own, empty]);
  const agent = picked ?? fallback;
  return agent
    ? { pubkey: agent.pubkey, name: agent.managedName ?? agent.name }
    : undefined;
}

/** The agent in the most recently active Solo chat that has one, preferring
 * an agent run here when that chat has several. */
function recentSoloAgent<T extends { pubkey: string; managed: boolean }>(
  channels: readonly ChannelSummary[],
  selectable: readonly T[],
) {
  const recent = channels
    .filter((channel) => channel.channelType === "solo" && !channel.archived)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  for (const channel of recent) {
    const members = selectable.filter((choice) =>
      channel.members?.includes(choice.pubkey),
    );
    const agent = members.find((choice) => choice.managed) ?? members[0];
    if (agent) return agent;
  }
  return undefined;
}
