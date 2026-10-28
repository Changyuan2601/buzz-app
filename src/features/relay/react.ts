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
const activityFields = new Set(["lastActivityAt", "activityKnown"]);
function sameExceptActivity(a: ChannelSummary, b: ChannelSummary) {
  if (a === b) return true;
  const keys = (channel: ChannelSummary) =>
    Object.keys(channel).filter((key) => !activityFields.has(key));
  const own = keys(a);
  return (
    own.length === keys(b).length &&
    own.every(
      (key) =>
        key in b &&
        a[key as keyof ChannelSummary] === b[key as keyof ChannelSummary],
    )
  );
}
/** The channel list for views that never read live activity. Each incoming
 * message advances its channel's activity; that alone keeps the last snapshot,
 * so a whole page does not re-render for a sidebar ordering signal. */
export function useChannelListWithoutActivity(queries: ChannelQueries) {
  useEffect(() => queries.ensureList(), [queries]);
  const last = useRef<{ queries: ChannelQueries; list: ChannelList }>(
    undefined,
  );
  const snapshot = useCallback(() => {
    const list = queries.list();
    const previous =
      last.current?.queries === queries ? last.current.list : undefined;
    if (
      previous &&
      previous !== list &&
      Object.keys(list).length === Object.keys(previous).length &&
      Object.entries(list).every(
        ([key, value]) =>
          key === "channels" || previous[key as keyof ChannelList] === value,
      ) &&
      previous.channels.length === list.channels.length &&
      previous.channels.every((channel, index) =>
        sameExceptActivity(channel, list.channels[index] as ChannelSummary),
      )
    )
      return previous;
    last.current = { queries, list };
    return list;
  }, [queries]);
  return useSyncExternalStore(queries.subscribeList, snapshot, snapshot);
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
