import { rowProfileIds } from "./membership";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ChannelMessage, ChannelQueries, Profile } from "./contracts";
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
export function useChannelWindow(queries: ChannelQueries, channelId: string) {
  useEffect(() => queries.ensure(channelId), [queries, channelId]);
  // Render window changes at the start of the next frame, once for any number
  // of changes before it. A live row then commits before that frame's layout,
  // so the list measures it before the timeline's follow scroll, which runs a
  // frame later. Committed from a socket task, the row was still unmeasured
  // when that scroll ran; the list took the corrected scroll for a reader
  // gesture and remounted the rows behind it when it went idle.
  const subscribe = useCallback(
    (listener: () => void) => {
      let frame: number | undefined;
      const release = queries.subscribeWindow(channelId, () => {
        // Hidden documents run no frames.
        if (document.visibilityState === "hidden") listener();
        else
          frame ??= requestAnimationFrame(() => {
            frame = undefined;
            listener();
          });
      });
      return () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        release();
      };
    },
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
