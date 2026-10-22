import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { DEFAULT_ACTIVE_WINDOW_SECONDS } from "../../features/relay/sidebar-preferences";
import type { UnreadCapability } from "../../features/relay/unread";
import type { sidebarSections } from "./sidebar-sections";

export type { SidebarFilterMode as SidebarFilter } from "../../features/relay/sidebar-preferences";
import type { SidebarFilterMode as SidebarFilter } from "../../features/relay/sidebar-preferences";
export const SIDEBAR_ACTIVE_WINDOW = DEFAULT_ACTIVE_WINDOW_SECONDS * 1000;
/** Unfiltered DMs show only recent conversations; reopening a DM restores its history. */
export const SIDEBAR_DM_LIMIT = 20;

/** Filter only the existing section roster; the current destination always stays. */
export function useSidebarFilters(
  sections: ReturnType<typeof sidebarSections>,
  filters: Readonly<Record<string, SidebarFilter>>,
  current: string | undefined,
  unread: UnreadCapability,
  windows: Readonly<Record<string, number>> = {},
  activityReady = true,
  // Without saved preferences there is no Filter menu to reach older DMs.
  limitDms = true,
) {
  const ids = JSON.stringify(
    sections.flatMap((section) =>
      filters[section.key] === "unreads" ||
      (limitDms &&
        section.key === "dms" &&
        (filters[section.key] ?? "all") === "all")
        ? section.rows.map((row) => row.id)
        : [],
    ),
  );
  const unreadSet = useUnreadChannelIds(unread, ids);
  const [clock, tick] = useState(0);
  const now = Date.now();
  let nextExpiry = Infinity;
  // Unfiltered DMs keep the current, unread, and up to SIDEBAR_DM_LIMIT
  // conversations active within the default window, chosen by recency. Rows
  // with unknown activity stay visible without using a slot.
  const recentDms = <T extends (typeof sections)[number]["rows"][number]>(
    rows: readonly T[],
  ) => {
    const recent = new Set(
      rows
        .filter((channel) => {
          if (channel.lastActivityAt === undefined) return false;
          const expiry = channel.lastActivityAt * 1000 + SIDEBAR_ACTIVE_WINDOW;
          if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
          return expiry > now;
        })
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, SIDEBAR_DM_LIMIT)
        .map(({ id }) => id),
    );
    return rows.filter(
      (channel) =>
        channel.id === current ||
        unreadSet.has(channel.id) ||
        recent.has(channel.id) ||
        (channel.lastActivityAt === undefined &&
          !channel.activityKnown &&
          !activityReady),
    );
  };
  // Unknown activity is not inactivity. Keep those rows during loading or a
  // failed read; a successful read can establish that a channel has no activity.
  const visible = sections.map((section) => {
    const mode = filters[section.key] ?? "all";
    const activeWindow =
      (windows[section.key] ?? DEFAULT_ACTIVE_WINDOW_SECONDS) * 1000;
    const rows = section.rows.filter((channel) => {
      if (mode === "active" && channel.lastActivityAt !== undefined) {
        const expiry = channel.lastActivityAt * 1000 + activeWindow;
        if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
      }
      return (
        channel.id === current ||
        mode === "all" ||
        (mode === "unreads" && unreadSet.has(channel.id)) ||
        (mode === "active" &&
          (channel.lastActivityAt === undefined
            ? !channel.activityKnown && !activityReady
            : channel.lastActivityAt * 1000 + activeWindow > now))
      );
    });
    const shown =
      limitDms && section.key === "dms" && mode === "all"
        ? recentDms(rows)
        : rows;
    const visibleIds = new Set(shown.map(({ id }) => id));
    return {
      ...section,
      allRows: section.rows,
      rows: shown,
      hiddenRows: section.rows.filter(({ id }) => !visibleIds.has(id)),
    };
  });
  // One owned deadline keeps an idle sidebar correct when activity ages out.
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => tick(clock + 1),
      Math.min(Math.max(0, nextExpiry - Date.now()), 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, clock]);
  return visible;
}

/** Channels among `ids` (a JSON id array) with unread messages or threads. */
export function useUnreadChannelIds(unread: UnreadCapability, ids: string) {
  const targets = useMemo(
    () =>
      (JSON.parse(ids) as string[]).map((channelId) => ({
        kind: "channel" as const,
        channelId,
      })),
    [ids],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = targets.flatMap((target) => [
        unread.subscribe(target, listener),
        unread.subscribeActivity(target.channelId, listener),
      ]);
      return () => {
        for (const stop of stops) stop();
      };
    },
    [targets, unread],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        targets
          .filter((target) => {
            const state = unread.snapshot(target);
            return (
              state.manual !== "none" ||
              (state.observedCount ?? 0) > 0 ||
              (unread.activity(target.channelId).items?.length ?? 0) > 0
            );
          })
          .map((target) => target.channelId),
      ),
    [targets, unread],
  );
  const unreadIds = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => new Set<string>(JSON.parse(unreadIds)), [unreadIds]);
}
