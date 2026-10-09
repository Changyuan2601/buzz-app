import { useEffect, useSyncExternalStore } from "react";
import { meGroups } from "../relay/me-preferences";
import type { RelaySession } from "../relay/session";

/** Plugin organization only. Neither placement nor plugin availability grants access. */
export function useMePlacement(session: RelaySession) {
  const placement = session.mePlacement;
  const state = useSyncExternalStore(placement.subscribe, placement.snapshot);
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  useEffect(() => {
    if (channels.status === "ready") placement.ensure();
  }, [placement, channels.status]);
  const entry = meGroups(state.entries);
  const ids =
    !entry?.record.deleted && entry?.record.value.type === "groups"
      ? (entry.record.value.channels ?? [])
      : [];
  return { ...state, ids };
}
