import { rowProfileIds } from "./membership";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  return useWindowSnapshot(subscribe, snapshot);
}
/** Like useSyncExternalStore, but a window's first rows render as a
 * transition: an opening page renders in interruptible slices instead of one
 * long task. Later rows, a different channel, or a change missed before
 * subscribing still render synchronously, so typing cannot hold back arrivals
 * and scrolling cannot restart older pages. */
function useWindowSnapshot(
  subscribe: (listener: () => void) => () => void,
  read: () => ChannelWindow,
): ChannelWindow {
  const [state, setState] = useState(() => ({ subscribe, value: read() }));
  const value = state.subscribe === subscribe ? state.value : read();
  const rendered = useRef(value);
  rendered.current = value;
  useEffect(() => {
    const next = () => ({ subscribe, value: read() });
    if (read() !== rendered.current) setState(next());
    return subscribe(() => {
      const update = next();
      if (!rendered.current.rows.length && update.value.rows.length)
        startTransition(() => setState(update));
      else setState(update);
    });
  }, [subscribe, read]);
  return value;
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
