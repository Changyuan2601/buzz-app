import { rowProfileIds } from "./membership";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
  Profile,
} from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { selectProfiles } from "./profile-selection";

export function useChannelList(queries: ChannelQueries) {
  useEffect(() => queries.ensureList(), [queries]);
  return useSyncExternalStore(
    queries.subscribeList,
    queries.list,
    queries.list,
  );
}
export function useChannelWindow(
  queries: ChannelQueries,
  channelId: string,
  /** Keep the window when only an older-history load starts; the reader
   * takes that flag from useChannelLoadingOlder instead. */
  quietLoadStart = false,
) {
  useEffect(() => queries.ensure(channelId), [queries, channelId]);
  const subscribe = useCallback(
    (listener: () => void) => queries.subscribeWindow(channelId, listener),
    [queries, channelId],
  );
  const snapshot = useMemo(() => {
    let held: ChannelWindow | undefined;
    return () => {
      const next = queries.window(channelId);
      if (quietLoadStart && held && startsLoadOnly(held, next)) return held;
      held = next;
      return next;
    };
  }, [queries, channelId, quietLoadStart]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
function startsLoadOnly(previous: ChannelWindow, next: ChannelWindow) {
  if (previous.loadingOlder || !next.loadingOlder) return false;
  const keys = Object.keys(next) as (keyof ChannelWindow)[];
  return (
    keys.length === Object.keys(previous).length &&
    keys.every((key) => key === "loadingOlder" || next[key] === previous[key])
  );
}
export function useChannelLoadingOlder(
  queries: ChannelQueries,
  channelId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) => queries.subscribeWindow(channelId, listener),
    [queries, channelId],
  );
  const snapshot = useCallback(
    () => queries.window(channelId).loadingOlder,
    [queries, channelId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function useRowProfiles(
  queries: ProfileQueries,
  rows: readonly ChannelMessage[],
) {
  const ids = [...new Set(rows.flatMap(rowProfileIds))].sort().join(":");
  // New rows usually add authors whose profiles are still loading. Keep the map
  // identity then, so memoized rows do not all re-render for each page.
  const last = useRef<ReadonlyMap<string, Profile>>(undefined);
  const selection = useMemo(
    () => selectProfiles(queries, ids ? ids.split(":") : [], last.current),
    [queries, ids],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  last.current = profiles;
  return profiles;
}

/** Subscribe to replacement as well as connection readiness; never capture a startup session once. */
export function useRelayConnection(relay: import("./service").RelayData) {
  return useSyncExternalStore(relay.subscribe, relay.snapshot, relay.snapshot);
}
