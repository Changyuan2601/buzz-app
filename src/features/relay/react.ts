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
// Snapshots useChannelWindow publishes; their own loadingOlder may be stale.
const quietWindows = new WeakSet<ChannelWindow>();
/** A window snapshot that keeps its identity while only `loadingOlder`
 * changes, so a timeline does not re-render every row when a page starts or
 * ends. Read that flag with useLoadingOlder. */
export function useChannelWindow(queries: ChannelQueries, channelId: string) {
  useEffect(() => queries.ensure(channelId), [queries, channelId]);
  const subscribe = useCallback(
    (listener: () => void) => queries.subscribeWindow(channelId, listener),
    [queries, channelId],
  );
  const snapshot = useMemo(() => {
    let last: ChannelWindow | undefined;
    return () => {
      const next = queries.window(channelId);
      if (
        last &&
        [...new Set([...Object.keys(last), ...Object.keys(next)])].every(
          (key) =>
            key === "loadingOlder" ||
            last?.[key as keyof ChannelWindow] ===
              next[key as keyof ChannelWindow],
        )
      )
        return last;
      quietWindows.add(next);
      last = next;
      return next;
    };
  }, [queries, channelId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
/** The window's loadingOlder: live from the store for a useChannelWindow
 * snapshot, as given for any other window. */
export function useLoadingOlder(
  queries: ChannelQueries,
  channelId: string,
  window: ChannelWindow,
) {
  const live = quietWindows.has(window);
  const subscribe = useCallback(
    (listener: () => void) =>
      live ? queries.subscribeWindow(channelId, listener) : () => {},
    [queries, channelId, live],
  );
  const snapshot = useCallback(
    () => (live ? queries.window(channelId).loadingOlder : window.loadingOlder),
    [queries, channelId, live, window],
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
