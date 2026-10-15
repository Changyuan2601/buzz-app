import { useCallback, useSyncExternalStore } from "react";
import type { ChannelDetailsDraft } from "../relay/channel-details-protocol";
import type { RelaySession } from "../relay/session";

/** In-process orchestration only. Details and Me preferences own signed writes
 * and durable uncertainty; this receipt never authorizes either operation. */
export type SessionConversion = {
  draft: ChannelDetailsDraft;
  converted?: true;
  removalOnly?: true;
  running?: true;
};
const conversions = new WeakMap<
  RelaySession,
  ReadonlyMap<string, SessionConversion>
>();
const listeners = new WeakMap<RelaySession, Set<() => void>>();
const empty: ReadonlyMap<string, SessionConversion> = new Map();
export function sessionConversion(session: RelaySession, id: string) {
  return conversions.get(session)?.get(id);
}
export function updateSessionConversion(
  session: RelaySession,
  id: string,
  value: SessionConversion | undefined,
) {
  const next = new Map(conversions.get(session));
  if (value) next.set(id, value);
  else next.delete(id);
  conversions.set(session, next);
  for (const notify of listeners.get(session) ?? []) notify();
}
export function useSessionConversions(session: RelaySession) {
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
    () => conversions.get(session) ?? empty,
  );
}
export function conversionLabel(session: RelaySession, id: string) {
  return sessionConversion(session, id)
    ? "Finish conversion"
    : session.channels.list().channels.find((channel) => channel.id === id)
          ?.channelType === "stream"
      ? "Move to Multiplayer"
      : "Convert to channel";
}
