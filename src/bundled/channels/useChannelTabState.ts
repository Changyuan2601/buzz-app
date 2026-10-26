import { threadTabPane } from "../../features/messages/thread-preferences";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { PanelOpening } from "../../features/panels/service";

export type ConversationTab =
  | {
      id: string;
      kind: "conversation";
      channelId: string;
      /** The message the tab opens at, revealed once per `revealRequest`. */
      messageId?: string | undefined;
      revealRequest?: number | undefined;
      /** False: seeing messages here marks none read; the opener decides. */
      markRead?: false | undefined;
      /** Each new value focuses the composer. */
      focusRequest?: number | undefined;
    }
  | {
      id: string;
      kind: "thread";
      channelId: string;
      messageId: string;
      replyRequest?: number | undefined;
      /** Each new value focuses the reply box, keeping its target. */
      focusRequest?: number | undefined;
      /** Each new value reveals `messageId` again; set only by openings at it. */
      revealRequest?: number | undefined;
      /** Transient visual cue when an opening reuses this tab. */
      attentionRequest?: number | undefined;
      /** Threads live in the side pane unless moved or opened into main. */
      pane?: TabPane | undefined;
      /** The reader's verified root, which may differ from a link's hint. */
      rootId?: string | undefined;
      /** A name given to the tab, shown instead of its root's text. */
      name?: string | undefined;
    };
export type TabPane = "main" | "side";
export const tabPane = (tab: ConversationTab): TabPane =>
  tab.kind === "thread" && tab.pane === "main" ? "main" : "side";
type VisitSelection = {
  selected: string;
  mainSelected?: string | undefined;
  paneOpen: boolean;
};
type State = {
  entries: PanelOpening[];
  /** Panel tabs moved to the main pane, by tab id; the rest are in the side. */
  mainEntries?: string[] | undefined;
  tabs: ConversationTab[];
  selected: string;
  /** Selected main-pane tab; undefined is the channel conversation. */
  mainSelected?: string | undefined;
  /** The last history visit applied, so remounting never reapplies it. */
  visit?: string | undefined;
  /** Selection each recent visit had when it was left. */
  visits?: Record<string, VisitSelection> | undefined;
  /** The current visit's selection was already captured as it was left. */
  left?: boolean;
  paneOpen: boolean;
  thread: { channelId: string; messageId: string } | undefined;
  settings: { id: string; channelId: string | undefined } | undefined;
  /** A launcher's side panel shows in the pane; the page owns that panel. */
  sidePanel?: boolean;
};
// Apply one history visit once. Leaving a visit remembers its selection, so
// Back/Forward restore which tabs were selected and never close any.
const snapshotOf = (state: State): VisitSelection => ({
  selected: state.selected,
  mainSelected: state.mainSelected,
  // An empty pane is not visible, even if its preferred open flag is true.
  // Restoring it after a new thread arrived must not reveal that later thread.
  paneOpen:
    state.paneOpen &&
    !!(
      state.tabs.some((tab) => tabPane(tab) === "side") ||
      sideEntries(state).length ||
      state.settings ||
      state.thread
    ),
});
const remember = (state: State) => {
  if (!state.visit) return state.visits;
  const visits = { ...state.visits, [state.visit]: snapshotOf(state) };
  const keys = Object.keys(visits);
  for (const key of keys.slice(0, Math.max(0, keys.length - 50)))
    delete visits[key];
  return visits;
};

const empty: State = {
  entries: [],
  tabs: [],
  selected: "thread",
  paneOpen: true,
  thread: undefined,
  settings: undefined,
};
export const panelTabId = (entry: PanelOpening) =>
  `${entry.panel.key}:${entry.target}`;
/** Which pane a panel tab is in, given its state's main-pane ids. */
export const entryPane = (
  mainEntries: readonly string[] | undefined,
  entry: PanelOpening,
): TabPane => (mainEntries?.includes(panelTabId(entry)) ? "main" : "side");
const sideEntries = (state: State) =>
  state.entries.filter(
    (entry) => entryPane(state.mainEntries, entry) === "side",
  );
export const selectedTabId = (selected: string, ids: readonly string[]) =>
  ids.includes(selected) ? selected : (ids[0] ?? "");
const sideSelection = (state: State) =>
  selectedTabId(state.selected, [
    ...(state.settings ? ["settings"] : []),
    ...state.tabs.filter((tab) => tabPane(tab) === "side").map((tab) => tab.id),
    ...sideEntries(state).map(panelTabId),
  ]);

/** A channel's open tab for a thread: by its verified root, or until then by
 * the id it was opened with. */
export const threadTab = (
  tabs: readonly ConversationTab[],
  channelId: string,
  rootId: string,
) =>
  tabs.find(
    (tab) =>
      tab.kind === "thread" &&
      tab.channelId === channelId &&
      (tab.rootId
        ? tab.rootId === rootId
        : tab.id === `thread:${channelId}:${rootId}`),
  );

/** Reply asks for the composer; select keeps the tab's requests; reveal asks
 * the reader to show `messageId` again. */
export type ThreadIntent = "reply" | "select" | "reveal" | "focus";

/** Opening a thread selects its existing tab or adds one in `pane`. */
function withThread(
  state: State,
  channelId: string,
  messageId: string,
  rootId: string,
  intent: ThreadIntent | undefined,
  pane: TabPane,
  attention = false,
): State {
  const existing = threadTab(state.tabs, channelId, rootId);
  const baseId = `thread:${channelId}:${rootId}`;
  const id =
    existing?.id ??
    (state.tabs.some((tab) => tab.id === baseId)
      ? `${baseId}:${crypto.randomUUID()}`
      : baseId);
  const prior = existing?.kind === "thread" ? existing : undefined;
  const next: ConversationTab = {
    id,
    kind: "thread",
    channelId,
    messageId,
    attentionRequest:
      prior && attention
        ? (prior.attentionRequest ?? 0) + 1
        : prior?.attentionRequest,
    replyRequest:
      intent === "reply"
        ? (prior?.replyRequest ?? 0) + 1
        : intent === "select" || intent === "reveal" || intent === "focus"
          ? prior?.replyRequest
          : undefined,
    focusRequest:
      intent === "focus" ? (prior?.focusRequest ?? 0) + 1 : prior?.focusRequest,
    revealRequest:
      intent === "reveal"
        ? (prior?.revealRequest ?? 0) + 1
        : prior?.revealRequest,
    // An already-open thread stays wherever it was placed.
    pane: prior ? tabPane(prior) : pane,
    rootId: prior?.rootId,
    name: prior?.name,
  };
  const tabs = existing
    ? state.tabs.map((tab) => (tab.id === id ? next : tab))
    : [...state.tabs, next];
  return tabPane(next) === "main"
    ? { ...state, tabs, mainSelected: id }
    : { ...state, tabs, selected: id, paneOpen: true };
}

// Pages mount and unmount during navigation; their tab descriptors belong to
// the community session. Weak ownership retires them with that session.
const sessions = new WeakMap<RelaySession, ReturnType<typeof createTabStore>>();
function createTabStore() {
  let channels: Record<string, State> = {};
  const listeners = new Set<() => void>();
  const mounts = new Map<string, number>();
  return {
    visible: (key: string) => mounts.has(key),
    mount(key: string) {
      mounts.set(key, (mounts.get(key) ?? 0) + 1);
      return () => {
        const remaining = (mounts.get(key) ?? 1) - 1;
        if (remaining) mounts.set(key, remaining);
        else mounts.delete(key);
      };
    },
    snapshot: () => channels,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Changes one page's channel workspace. */
    update(key: string, change: (previous: State) => State) {
      const previous = channels[key] ?? empty;
      const next = change(previous);
      if (next === previous) return;
      channels = { ...channels, [key]: next };
      for (const listener of listeners) listener();
    },
  };
}
const keyOf = (page: string, channelId: string) =>
  JSON.stringify([page, channelId]);
function storeOf(session: RelaySession) {
  let store = sessions.get(session);
  if (!store) {
    store = createTabStore();
    sessions.set(session, store);
  }
  return store;
}

/** A blank name restores the tab's automatic title. */
const named = (tab: ConversationTab, name: string): ConversationTab =>
  tab.kind === "thread" ? { ...tab, name: name.trim() || undefined } : tab;
// Until its reader verifies the root, a tab's id holds the root it was opened
// with, before any disambiguating suffix.
export const rootOfTab = (tab: Extract<ConversationTab, { kind: "thread" }>) =>
  tab.rootId ??
  (tab.id.slice(`thread:${tab.channelId}:`.length).split(":")[0] as string);
/** A channel's own thread tabs in its workspace, changed from outside the
 * page. Tabs the viewer opened for other channels' threads are left alone.
 * Opening never moves the viewer's selection or focus, and closing refuses
 * the tab the viewer sees, so no selection needs repair. */
export function channelTabs(session: RelaySession) {
  const store = storeOf(session);
  const stateOf = (channelId: string) =>
    store.snapshot()[keyOf("messages", channelId)] ?? empty;
  const threads = (channelId: string) => {
    const state = stateOf(channelId);
    const visible = store.visible(keyOf("messages", channelId));
    const selected = sideSelection(state);
    return state.tabs.flatMap((tab) =>
      tab.kind === "thread" && tab.channelId === channelId
        ? [
            {
              tab,
              root: rootOfTab(tab),
              pane: tabPane(tab),
              name: tab.name,
              shown:
                visible &&
                (tabPane(tab) === "main"
                  ? state.mainSelected === tab.id
                  : state.paneOpen && selected === tab.id),
            },
          ]
        : [],
    );
  };
  return {
    list: (channelId: string) =>
      threads(channelId).map(({ tab: _, ...thread }) => thread),
    /** Opens thread `rootId` of `channelId` in its workspace; false when it
     * already has a tab there. */
    open(channelId: string, rootId: string) {
      const channel = session.channels
        .list()
        .channels.find((item) => item.id === channelId);
      if (!channel || channel.readOnly || channel.archived || channel.cached)
        throw new Error("Your owner cannot open threads in this channel.");
      if (threads(channelId).some((thread) => thread.root === rootId))
        return false;
      store.update(keyOf("messages", channelId), (state) => {
        // Solo chats have no main tab workspace.
        const pane = channel.channelType === "solo" ? "side" : threadTabPane();
        const opened = withThread(
          state,
          channelId,
          rootId,
          rootId,
          undefined,
          pane,
        );
        // An empty side pane stays closed; its toggle offers the new tab.
        const sideEmpty =
          !state.sidePanel &&
          !state.settings &&
          !sideEntries(state).length &&
          !state.tabs.some((tab) => tabPane(tab) === "side");
        return {
          ...opened,
          selected: sideSelection(state) || state.selected,
          mainSelected: state.mainSelected,
          paneOpen: pane === "side" && sideEmpty ? false : state.paneOpen,
        };
      });
      return true;
    },
    close(channelId: string, rootId: string): "closed" | "missing" | "shown" {
      const thread = threads(channelId).find((item) => item.root === rootId);
      if (!thread) return "missing";
      if (thread.shown) return "shown";
      store.update(keyOf("messages", channelId), (state) => ({
        ...state,
        tabs: state.tabs.filter((tab) => tab !== thread.tab),
      }));
      return "closed";
    },
    /** Names thread `rootId`'s tab; an empty name restores its automatic
     * title. False when it has no tab there. */
    rename(channelId: string, rootId: string, name: string) {
      const thread = threads(channelId).find((item) => item.root === rootId);
      if (!thread) return false;
      store.update(keyOf("messages", channelId), (state) => ({
        ...state,
        tabs: state.tabs.map((tab) =>
          tab === thread.tab ? named(tab, name) : tab,
        ),
      }));
      return true;
    },
  };
}

/** No credentials, page callbacks, or DOM elements are retained. */
export function useChannelTabState(
  session: RelaySession,
  channelId: string | undefined,
  page = "messages",
) {
  const store = storeOf(session);
  const channels = useSyncExternalStore(store.subscribe, store.snapshot);
  const snapshot = store.snapshot;
  const key = keyOf(page, channelId ?? "");
  // Retain descriptors across navigation, but protect only a mounted workspace.
  useLayoutEffect(() => store.mount(key), [key, store]);
  const state = channels[key] ?? empty;
  const update = useCallback(
    (change: (previous: State) => State) => store.update(key, change),
    [key, store],
  );
  const setEntries = useCallback(
    (entries: PanelOpening[]) =>
      update((s) => {
        // A closed panel tab forgets its pane.
        const ids = new Set(entries.map(panelTabId));
        const mainEntries = s.mainEntries?.filter((id) => ids.has(id));
        return {
          ...s,
          entries,
          mainEntries: mainEntries?.length ? mainEntries : undefined,
        };
      }),
    [update],
  );
  const retireMenuEntries = useCallback(
    () =>
      update((s) => {
        const entries = s.entries.filter((entry) => !entry.panel.channelMenu);
        if (entries.length === s.entries.length) return s;
        return {
          ...s,
          entries,
          selected: s.entries.some(
            (entry) =>
              entry.panel.channelMenu && panelTabId(entry) === s.selected,
          )
            ? "thread"
            : s.selected,
        };
      }),
    [update],
  );
  const setTabs = useCallback(
    (change: (tabs: ConversationTab[]) => ConversationTab[]) =>
      update((s) => ({ ...s, tabs: change(s.tabs) })),
    [update],
  );
  // Opening and selection are one channel-store update. The caller owns
  // current access/visit checks; no navigation request is retained here.
  const openThreadTab = useCallback(
    (
      channelId: string,
      messageId: string,
      rootId: string,
      intent?: ThreadIntent,
      pane: TabPane = threadTabPane(),
    ) =>
      update((state) =>
        withThread(state, channelId, messageId, rootId, intent, pane, true),
      ),
    [update],
  );
  // An action that starts a new visit (opening a thread) captures the current
  // one first, before it changes any selection.
  const leaveVisit = useCallback(
    () =>
      update((state) =>
        state.visit && !state.left
          ? { ...state, visits: remember(state), left: true }
          : state,
      ),
    [update],
  );
  // A hint addressed an existing tab, but its verified reader rejected that
  // ancestry. Preserve its editor and let a provisional tab resolve the link.
  const divertThread = useCallback(
    (id: string, requested: string, kept: string) =>
      update((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (tab?.kind !== "thread" || tab.messageId !== requested) return state;
        const visible =
          tabPane(tab) === "main"
            ? state.mainSelected === id
            : state.selected === id && state.paneOpen;
        const restored = {
          ...state,
          tabs: state.tabs.map((item) =>
            item === tab ? { ...tab, messageId: kept } : item,
          ),
        };
        const next = withThread(
          restored,
          tab.channelId,
          requested,
          requested,
          "select",
          tabPane(tab),
        );
        return visible
          ? next
          : { ...next, ...snapshotOf(state), paneOpen: state.paneOpen };
      }),
    [update],
  );
  // Apply one history visit once. Thread visits select their thread; other
  // visits restore the tabs they last had. Nothing is ever closed.
  const enterVisit = useCallback(
    (
      visit: string,
      routed?: {
        channelId: string;
        messageId: string;
        rootId: string;
        pane?: TabPane | undefined;
      },
      /** A new visit keeps the current selection instead of the conversation. */
      keep = false,
    ) =>
      update((state) => {
        if (state.visit === visit) return state;
        const visits = state.left ? state.visits : remember(state);
        const next: State = { ...state, visit, visits, left: false };
        if (routed)
          return withThread(
            next,
            routed.channelId,
            routed.messageId,
            routed.rootId,
            "select",
            routed.pane ?? threadTabPane(),
          );
        const saved = visits?.[visit];
        return saved
          ? { ...next, ...saved }
          : keep
            ? next
            : { ...next, mainSelected: undefined };
      }),
    [update],
  );
  // Relocate one tab to a position within a pane's own order. The tab's
  // identity and mounted content are unchanged; only placement moves.
  const moveTab = useCallback(
    (id: string, pane: TabPane, index: number) =>
      update((state) => {
        const moving = state.tabs.find((tab) => tab.id === id);
        if (moving?.kind !== "thread") return state;
        const rest = state.tabs.filter((tab) => tab.id !== id);
        const inPane = rest.filter((tab) => tabPane(tab) === pane);
        const before = inPane[Math.max(0, index)];
        const placed = { ...moving, pane };
        const at = before ? rest.indexOf(before) : rest.length;
        const tabs = [...rest.slice(0, at), placed, ...rest.slice(at)];
        const left = tabPane(moving) !== pane;
        return {
          ...state,
          tabs,
          ...(pane === "main"
            ? {
                mainSelected: id,
                ...(left && state.selected === id ? { selected: "" } : {}),
              }
            : {
                selected: id,
                paneOpen: true,
                ...(left && state.mainSelected === id
                  ? { mainSelected: undefined }
                  : {}),
              }),
        };
      }),
    [update],
  );
  // A panel tab keeps its place in the entry list; only its pane changes.
  const moveEntry = useCallback(
    (id: string, pane: TabPane) =>
      update((state) => {
        const entry = state.entries.find((item) => panelTabId(item) === id);
        if (!entry) return state;
        const left = entryPane(state.mainEntries, entry) !== pane;
        const others = (state.mainEntries ?? []).filter((item) => item !== id);
        const placed = pane === "main" ? [...others, id] : others;
        const mainEntries = placed.length ? placed : undefined;
        return {
          ...state,
          mainEntries,
          ...(pane === "main"
            ? {
                mainSelected: id,
                // The side pane shows its next tab instead.
                ...(left && state.selected === id
                  ? { selected: sideSelection({ ...state, mainEntries }) }
                  : {}),
              }
            : {
                selected: id,
                paneOpen: true,
                ...(left && state.mainSelected === id
                  ? { mainSelected: undefined }
                  : {}),
              }),
        };
      }),
    [update],
  );
  // Once a reader verifies its root, a tab opened from a wrong hint merges
  // into the tab already holding that thread instead of duplicating it.
  const resolveThreadRoot = useCallback(
    (id: string, rootId: string) =>
      update((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (tab?.kind !== "thread" || tab.rootId === rootId) return state;
        const owner = state.tabs.find(
          (item) =>
            item.kind === "thread" &&
            item !== tab &&
            item.channelId === tab.channelId &&
            (item.rootId
              ? item.rootId === rootId
              : item.id === `thread:${tab.channelId}:${rootId}`),
        );
        if (owner?.kind !== "thread")
          return {
            ...state,
            tabs: state.tabs.map((item) =>
              item === tab ? { ...tab, rootId } : item,
            ),
          };
        const selected =
          tabPane(tab) === "main"
            ? state.mainSelected === tab.id
            : state.selected === tab.id;
        // Late identity evidence deduplicates, never overrides newer selection
        // or retargets another reader after the user has left this provisional tab.
        const foreground =
          selected && (tabPane(tab) === "main" || state.paneOpen);
        // A name given to the provisional tab survives an unnamed owner.
        const name = owner.name ?? tab.name;
        const merged = foreground
          ? { ...owner, messageId: tab.messageId, rootId, name }
          : { ...owner, name };
        const tabs = state.tabs
          .filter((item) => item !== tab)
          .map((item) => (item === owner ? merged : item));
        if (!foreground)
          return {
            ...state,
            tabs,
            ...(selected
              ? { selected: tabPane(owner) === "side" ? owner.id : "" }
              : {}),
          };
        return tabPane(merged) === "main"
          ? {
              ...state,
              tabs,
              mainSelected: merged.id,
              ...(state.selected === tab.id ? { selected: "" } : {}),
            }
          : {
              ...state,
              tabs,
              selected: merged.id,
              paneOpen: true,
              ...(state.mainSelected === tab.id
                ? { mainSelected: undefined }
                : {}),
            };
      }),
    [update],
  );
  const selectMain = useCallback(
    (mainSelected: string | undefined) =>
      update((s) =>
        s.mainSelected === mainSelected ? s : { ...s, mainSelected },
      ),
    [update],
  );
  const select = useCallback(
    (selected: string) =>
      update((s) => ({
        ...s,
        selected,
        ...(selected ? { paneOpen: true } : {}),
      })),
    [update],
  );
  const setThread = useCallback(
    (thread: State["thread"]) =>
      update((s) =>
        s.thread?.channelId === thread?.channelId &&
        s.thread?.messageId === thread?.messageId
          ? s
          : { ...s, thread },
      ),
    [update],
  );
  const setSettings = useCallback(
    (settings: { channelId: string | undefined } | undefined) =>
      update((s) => ({
        ...s,
        settings: settings
          ? s.settings && s.settings.channelId === settings.channelId
            ? s.settings
            : { ...settings, id: crypto.randomUUID() }
          : undefined,
        ...(settings ? { selected: "settings", paneOpen: true } : {}),
      })),
    [update],
  );
  /** Closes this channel's tabs in both panes, except `keep` if given, which
   * stays open and selected. */
  const closeTabs = useCallback(
    (keep?: string) =>
      update((s) => {
        const tab = s.tabs.find((item) => item.id === keep);
        const entry = s.entries.find((item) => panelTabId(item) === keep);
        const settings = keep === "settings" ? s.settings : undefined;
        const main =
          (!!tab && tabPane(tab) === "main") ||
          (!!entry && entryPane(s.mainEntries, entry) === "main");
        // The channel conversation is not stored: keeping it closes them all.
        const side = !main && !!(tab || entry || settings);
        return {
          ...s,
          entries: entry ? [entry] : [],
          mainEntries: entry && main ? [panelTabId(entry)] : undefined,
          tabs: tab ? [tab] : [],
          selected: (side && keep) || "",
          mainSelected: main ? keep : undefined,
          paneOpen: side,
          thread: undefined,
          settings,
        };
      }),
    [update],
  );
  const setPaneOpen = useCallback(
    (paneOpen: boolean) => update((s) => ({ ...s, paneOpen })),
    [update],
  );
  const renameTab = useCallback(
    (id: string, name: string) =>
      update((s) => ({
        ...s,
        tabs: s.tabs.map((tab) => (tab.id === id ? named(tab, name) : tab)),
      })),
    [update],
  );
  const setSidePanel = useCallback(
    (sidePanel: boolean) =>
      update((s) => (!!s.sidePanel === sidePanel ? s : { ...s, sidePanel })),
    [update],
  );
  // Stable, so a memoized timeline can ask at the moment it opens a thread.
  const hasThreadTab = useCallback(
    (channelId: string, rootId: string) =>
      !!threadTab(snapshot()[key]?.tabs ?? [], channelId, rootId),
    [key, snapshot],
  );
  // Workspace callbacks list this object as a dependency; a fresh object per
  // render would recreate them and re-render every memoized message row.
  return useMemo(
    () => ({
      ...state,
      // Synchronous actions need the selection before React rerenders.
      getSelected: () => snapshot()[key]?.selected ?? empty.selected,
      hasThreadTab,
      setEntries,
      retireMenuEntries,
      setTabs,
      openThreadTab,
      moveTab,
      moveEntry,
      resolveThreadRoot,
      divertThread,
      enterVisit,
      leaveVisit,
      selectMain,
      select,
      setThread,
      setSettings,
      setPaneOpen,
      setSidePanel,
      renameTab,
      closeTabs,
    }),
    [
      state,
      snapshot,
      key,
      hasThreadTab,
      setEntries,
      retireMenuEntries,
      setTabs,
      openThreadTab,
      moveTab,
      moveEntry,
      resolveThreadRoot,
      divertThread,
      enterVisit,
      leaveVisit,
      selectMain,
      select,
      setThread,
      setSettings,
      setPaneOpen,
      setSidePanel,
      renameTab,
      closeTabs,
    ],
  );
}
