import { useSyncExternalStore } from "react";
import type { ChannelList, ChannelQueries, ChannelSummary } from "./contracts";

const unlisted = () => () => {};
const listed = new WeakMap<ChannelList, Map<string, ChannelSummary>>();
const rosterOnly = { activity: false } as const;
const rosters = new WeakMap<object, (listener: () => void) => () => void>();
/** A stable `subscribeList` for readers of roster facts, not live activity. */
export function rosterSubscription(
  queries: Pick<ChannelQueries, "subscribeList">,
) {
  let subscribe = rosters.get(queries);
  if (!subscribe) {
    subscribe = (listener) => queries.subscribeList(listener, rosterOnly);
    rosters.set(queries, subscribe);
  }
  return subscribe;
}
/** One roster fact about one channel. Previews and activity replace the list and
 * its summaries on every message, so `select` must return a primitive or a
 * reference the store retains (such as `members`); the caller then renders only
 * when that fact changes. Live activity alone does not notify, so `select`
 * must not read it. */
export function useListedChannel<T>(
  queries: Partial<Pick<ChannelQueries, "list" | "subscribeList">> | undefined,
  channelId: string | undefined,
  select: (channel: ChannelSummary | undefined) => T,
): T {
  const snapshot = () => {
    const list = queries?.list?.();
    if (!list || channelId === undefined) return select(undefined);
    let index = listed.get(list);
    if (!index) {
      index = new Map();
      for (const channel of list.channels)
        if (!index.has(channel.id)) index.set(channel.id, channel);
      listed.set(list, index);
    }
    return select(index.get(channelId));
  };
  return useSyncExternalStore(
    queries?.subscribeList
      ? rosterSubscription(queries as Pick<ChannelQueries, "subscribeList">)
      : unlisted,
    snapshot,
    snapshot,
  );
}
