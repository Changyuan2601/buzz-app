import { useCallback, useSyncExternalStore } from "react";
import { trackMemberAdditionReceipts } from "../channel-members/operations";
import type { RelaySession } from "../relay/session";
import type { MemberAdditionIntent } from "../channel-members/members";

export type ShareIntent = Readonly<{
  destination: string;
  chatPeople: readonly string[];
}>;
export type ShareAttempt = {
  intent: ShareIntent;
  messageId?: string;
  grants: Map<string, MemberAdditionIntent>;
  /** Frozen after a fresh destination roster read, before any chat grants. */
  audienceKeys?: readonly string[];
  /** Original destination evidence for device-local display, never retry authority. */
  channelSnapshot?: { id: string; name: string; members: readonly string[] };
  /** Two mounted entry points must never enqueue competing link operations. */
  running?: boolean;
  stopReceipts?: (() => void) | undefined;
};

// A submitted attempt is owned by this relay session, not its dialog. The
// Outbox/memberAdditions remain the durable operation owners.
const attempts = new WeakMap<RelaySession, Map<string, ShareAttempt>>();
const listeners = new WeakMap<RelaySession, Set<() => void>>();
const empty: ReadonlyMap<string, ShareAttempt> = new Map();

/** Observe presence only; receipts and frozen intent remain owned by the attempt. */
export function useSoloShareAttempts(session: RelaySession) {
  return useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        let callbacks = listeners.get(session);
        if (!callbacks) {
          callbacks = new Set();
          listeners.set(session, callbacks);
        }
        callbacks.add(notify);
        return () => {
          callbacks.delete(notify);
        };
      },
      [session],
    ),
    () => attempts.get(session) ?? empty,
  );
}
function changed(session: RelaySession) {
  for (const notify of listeners.get(session) ?? []) notify();
}
export function soloShareAttempt(session: RelaySession, sourceId: string) {
  return attempts.get(session)?.get(sourceId);
}
export function beginSoloShare(
  session: RelaySession,
  sourceId: string,
  intent: ShareIntent,
) {
  let bySource = attempts.get(session);
  if (!bySource) {
    bySource = new Map();
    attempts.set(session, bySource);
  }
  const existing = bySource.get(sourceId);
  if (existing) return existing;
  const attempt: ShareAttempt = {
    intent,
    grants: new Map<string, MemberAdditionIntent>(),
  };
  attempt.stopReceipts = trackMemberAdditionReceipts(session.outbox, () =>
    attempt.grants.values(),
  );
  attempts.set(session, new Map(bySource).set(sourceId, attempt));
  changed(session);
  return attempt;
}
export function finishSoloShare(session: RelaySession, sourceId: string) {
  soloShareAttempt(session, sourceId)?.stopReceipts?.();
  const next = new Map(attempts.get(session));
  if (next.delete(sourceId)) {
    attempts.set(session, next);
    changed(session);
  }
}
