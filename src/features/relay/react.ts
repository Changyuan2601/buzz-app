import { rowProfileIds } from "./membership";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  ChannelList,
  ChannelMessage,
  ChannelQueries,
  ChannelSummary,
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
/**
 * The roster for views that never show message previews, such as the sidebar.
 * A republish that changes only previews keeps the previous snapshot, so it
 * does not re-render them; any other channel or list change still does.
 */
export function useChannelRoster(queries: ChannelQueries) {
  useEffect(() => queries.ensureList(), [queries]);
  return useRosterView(queries);
}
/** useChannelRoster for a view whose owner already started the roster read. */
export function useRosterView(queries: ChannelQueries) {
  const last = useRef<ChannelList | undefined>(undefined);
  const snapshot = useCallback(() => {
    const next = queries.list();
    if (!last.current || !sameRoster(last.current, next)) last.current = next;
    return last.current;
  }, [queries]);
  return useSyncExternalStore(queries.subscribeList, snapshot, snapshot);
}
function sameRoster(a: ChannelList, b: ChannelList) {
  return (
    a === b ||
    (a.status === b.status &&
      a.coverage === b.coverage &&
      a.asOf === b.asOf &&
      a.activityStatus === b.activityStatus &&
      a.error === b.error &&
      a.channels.length === b.channels.length &&
      a.channels.every((channel, index) => {
        const other = b.channels[index];
        return !!other && sameExceptPreview(channel, other);
      }))
  );
}
function sameExceptPreview(a: ChannelSummary, b: ChannelSummary) {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("preview");
  for (const key of keys) {
    const x: unknown = a[key as keyof ChannelSummary];
    const y: unknown = b[key as keyof ChannelSummary];
    if (
      !Object.is(x, y) &&
      !(
        Array.isArray(x) &&
        Array.isArray(y) &&
        x.length === y.length &&
        x.every((item, index) => item === y[index])
      )
    )
      return false;
  }
  return true;
}
export function useChannelWindow(queries: ChannelQueries, channelId: string) {
  useEffect(() => queries.ensure(channelId), [queries, channelId]);
  const subscribe = useCallback(
    (listener: () => void) => queries.subscribeWindow(channelId, listener),
    [queries, channelId],
  );
  const snapshot = useCallback(
    () => queries.window(channelId),
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
