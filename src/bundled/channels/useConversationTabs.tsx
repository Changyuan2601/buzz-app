import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  panelOpening,
  type PanelOpening,
  type Panels,
} from "../../features/panels/service";
import { useTabDrag } from "../../features/panels/useTabDrag";
import { PanelCard } from "../../features/panels/PanelCard";
import type { MessageLinkOrigin } from "../../features/messages/MessageRow";
import {
  BrowserIcon,
  MessageReplyIcon,
  InfoIcon,
} from "../../shared/design-system/icons";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { ConversationTab } from "./ConversationTab";
import { TabSlot, useTabNodes } from "./TabHosts";
import { createPortal, flushSync } from "react-dom";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelPanels } from "./useChannelPanels";
import {
  panelTabId,
  rootOfTab,
  selectedTabId,
  tabPane,
  type ConversationTab as Tab,
  type TabPane,
  type useChannelTabState,
} from "./useChannelTabState";
import styles from "./Channels.module.css";
import tabStyles from "./ChannelTabs.module.css";

/** Shared secondary workspace. Pages retain their main reader and route semantics. */
export function useConversationTabs({
  state: tabState,
  relay,
  session: queries,
  panels,
  current,
  scope,
  channels,
  conversationIcon,
  extensions,
  leadingIds,
  continuingVisit,
  navigationSignal,
  isLive,
  openLink,
  fallbackFocus,
  eligible,
  threadId,
  onOpenDrawer,
  openMembers,
  mainPane = false,
  anyMainThread = false,
  threadPane,
  visits = true,
  navigation,
  routed,
  onCloseThread,
  onRetryNavigation,
}: {
  state: ReturnType<typeof useChannelTabState>;
  relay: RelayData;
  session: RelaySession;
  panels: Panels;
  current: ChannelSummary | undefined;
  scope: string;
  channels: readonly ChannelSummary[];
  conversationIcon(channel: ChannelSummary): ReactNode;
  extensions?: ConversationExtensions | undefined;
  leadingIds: string[];
  continuingVisit: boolean;
  navigationSignal?: AbortSignal | undefined;
  isLive(): boolean;
  openLink(url: string): boolean;
  fallbackFocus?: RefObject<HTMLElement | null>;
  eligible?(entry: PanelOpening): boolean;
  threadId?: string | undefined;
  onOpenDrawer?(): void;
  openMembers?(): void;
  /** This page hosts thread tabs in its main pane too. */
  mainPane?: boolean | undefined;
  /** Any thread may use the main pane, not only the current conversation's. */
  anyMainThread?: boolean | undefined;
  /** Where new thread tabs open; by default, per the thread placement setting. */
  threadPane?: TabPane | undefined;
  /** Showing a tab visits its conversation; a page may only reveal it. */
  visits?: boolean | undefined;
  /** Opens another conversation's tab where it lives, from the tab's menu. */
  navigation?: Pick<Navigation, "open"> | undefined;
  /** The route's thread request, handed only to the tab that matches it. */
  routed?:
    | { channelId: string; messageId: string; navigation: PageNavigation }
    | undefined;
  onCloseThread?(
    tab: Extract<Tab, { kind: "thread" }>,
    active: boolean,
    last: boolean,
  ): void;
  onRetryNavigation?(): void;
}) {
  const currentId = current?.id;
  const viewer = queries.viewer;
  const { entries, setEntries } = tabState;
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const canOpenLink = (target: string) => !!panels.resolve(target);
  const splitTrigger = useRef<HTMLButtonElement>(null);
  const focusSplit = useRef(false);
  // The opening control remounts in the main header when the pane closes.
  useLayoutEffect(() => {
    if (focusSplit.current) {
      const target = splitTrigger.current ?? fallbackFocus?.current;
      target?.focus({ preventScroll: true });
      focusSplit.current = false;
    }
  });
  const panelTrigger = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const visit = useMemo(() => ({ queries, currentId }), [queries, currentId]);
  const liveVisit = useRef(visit);
  useLayoutEffect(() => {
    mounted.current = true;
    liveVisit.current = visit;
    return () => {
      mounted.current = false;
    };
  }, [visit]);
  // Editing local tabs remains available while the retained Messages session reconnects.
  const currentVisit = () => mounted.current && liveVisit.current === visit;
  const active = () => {
    const connection = relay.snapshot();
    return (
      currentVisit() &&
      isLive() &&
      connection.status === "ready" &&
      connection.session === queries
    );
  };
  type Opening = PanelOpening;
  const opened = entries.find(
    (entry) => panelTabId(entry) === tabState.selected,
  );
  const entryList = useRef<Opening[]>(entries);
  const opening = useRef<Opening | undefined>(opened);
  const renderedChannel = useRef({ currentId, queries });
  if (
    renderedChannel.current.currentId !== currentId ||
    renderedChannel.current.queries !== queries
  ) {
    renderedChannel.current = { currentId, queries };
    entryList.current = entries;
    opening.current = opened;
  }
  const selectOpening = useCallback(
    (next: Opening | undefined) => {
      opening.current = next;
      tabState.select(next ? panelTabId(next) : "thread");
    },
    [tabState.select],
  );
  const open = useCallback(
    (next: Opening | undefined, append = false) => {
      const found = next
        ? entryList.current.find(
            (entry) =>
              entry.panel === next.panel && entry.target === next.target,
          )
        : undefined;
      // A tab retained for its channel stays retained when a link reopens it,
      // and a channel tool that reopens a link's tab takes it over. A link
      // from another conversation selects the retained tab unchanged.
      const kept =
        next && !next.channelContext ? found?.channelContext : undefined;
      const wanted =
        next && kept
          ? found?.channelId === next.channelId
            ? { ...next, channelContext: kept }
            : found
          : next;
      const existing =
        found && (append || found.channelContext) ? found : undefined;
      // A link from another conversation retargets the open tab's context.
      const retarget =
        existing &&
        wanted &&
        (existing.channelId !== wanted.channelId ||
          existing.rootId !== wanted.rootId ||
          existing.channelContext !== wanted.channelContext)
          ? wanted
          : undefined;
      const selected = retarget || existing || wanted;
      // Timeline actions replace transient details, never retained channel tools.
      const retained = append
        ? entryList.current
        : entryList.current.filter(
            (entry) =>
              entry === existing ||
              (entry.channelContext &&
                (!selected || panelTabId(entry) !== panelTabId(selected))),
          );
      const updated = retarget
        ? retained.map((entry) => (entry === existing ? retarget : entry))
        : selected && !existing
          ? [...retained, selected]
          : retained;
      entryList.current = updated;
      setEntries(updated);
      selectOpening(selected);
    },
    [selectOpening, setEntries],
  );
  const panelTabs = entries.filter(
    (entry) =>
      available.includes(entry.panel) &&
      (!eligible || eligible(entry)) &&
      (!entry.channelContext ||
        (current &&
          !current.readOnly &&
          !current.archived &&
          current.id === entry.channelId)),
  );
  const panel = opened && panelTabs.includes(opened) ? opened.panel : undefined;
  useEffect(() => {
    if (entries.length !== panelTabs.length) {
      entryList.current = panelTabs;
      setEntries(panelTabs);
    }
    if (opened && !panel) selectOpening(undefined);
  }, [entries.length, panelTabs, opened, panel, setEntries, selectOpening]);
  const panelActive = (entry: Opening) => {
    return !!(
      active() &&
      opened &&
      panel &&
      opening.current === entry &&
      panels.snapshot().includes(panel)
    );
  };
  const panelContext = (entry: Opening) => ({
    channelId: entry.channelId,
    ...(entry.rootId && { rootId: entry.rootId }),
    canOpen: (target: string) => !!panels.resolve(target),
    open: (target: string) => {
      if (!panelActive(entry)) return false;
      const next = panels.resolve(target);
      if (!next) return false;
      const existing = entryList.current.find(
        (item) => item.panel === next && item.target === target,
      );
      const replacement = existing ?? { ...entry, panel: next, target };
      entryList.current = entryList.current
        .map((item) => (item === entry ? replacement : item))
        .filter((item, index, all) => all.indexOf(item) === index);
      setEntries(entryList.current);
      selectOpening(replacement);
      return true;
    },
    push: (target: string) => {
      if (!panelActive(entry)) return false;
      const next = panelOpening(panels, entry.channelId, target, entry.rootId);
      if (!next) return false;
      open(next, true);
      return true;
    },
  });
  const tabId = panelTabId;
  const closeTab = (entry: Opening) => {
    if (!currentVisit() || !entryList.current.includes(entry)) return;
    const remaining = entryList.current.filter((item) => item !== entry);
    entryList.current = remaining;
    setEntries(remaining);
    afterClose(tabId(entry), panelTrigger.current);
  };
  const drawerContext = useMemo(
    () =>
      current && !current.readOnly && viewer
        ? {
            scope,
            viewer,
            channelId: current.id,
            channelName: current.name,
            ...(threadId && { threadId }),
            relayUrl: scope
              .slice(0, -(viewer.length + 1))
              .replace(/^https:/, "wss:")
              .replace(/^http:/, "ws:"),
          }
        : undefined,
    [scope, viewer, current, threadId],
  );
  const mainThread = (channelId: string) =>
    mainPane && (anyMainThread || channelId === currentId);
  const sideTabs = tabState.tabs.filter((tab) => tabPane(tab) === "side");
  const mainTabs = mainPane
    ? tabState.tabs.filter((tab) => tabPane(tab) === "main")
    : [];
  const rootTabIds = [
    ...leadingIds,
    ...sideTabs.map((tab) => tab.id),
    ...panelTabs.map(tabId),
  ];
  const selectedTab = selectedTabId(tabState.selected, rootTabIds);
  // A tab-placed channel launcher keeps one retained tab per channel.
  const channelTab = (panel: Opening["panel"], channelId: string) =>
    panelTabs.find(
      (entry) =>
        entry.panel === panel &&
        !!entry.channelContext &&
        entry.channelId === channelId,
    );
  const drawer = useChannelPanels(
    panels,
    drawerContext,
    () => {
      onOpenDrawer?.();
      tabState.setPaneOpen(true);
    },
    {
      pressed: (panel, context) => {
        const entry = channelTab(panel, context.channelId);
        return !!entry && tabState.paneOpen && selectedTab === tabId(entry);
      },
      toggle: (panel, context, target) => {
        if (!currentVisit()) return;
        const entry = channelTab(panel, context.channelId);
        if (entry && tabState.paneOpen && selectedTab === tabId(entry)) {
          closeTab(entry);
          return;
        }
        panelTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        tabState.setPaneOpen(true);
        const opening: Opening = {
          panel,
          channelId: context.channelId,
          target,
          channelContext: context,
        };
        // One tab per channel: a new target replaces the launcher's tab in place.
        if (entry && entry.target !== target)
          entryList.current = entryList.current
            .filter(
              (item) =>
                item === entry ||
                item.panel !== panel ||
                item.target !== target,
            )
            .map((item) => (item === entry ? opening : item));
        open(opening, true);
      },
    },
    {
      canOpen: canOpenLink,
      // Called only after render, once the link handler below exists.
      open: (target) =>
        !!drawerContext &&
        openConversationLink(drawerContext.channelId, target),
    },
    openMembers,
  );
  // The pane's page-local side panel, so a tab opened from outside the page
  // knows the pane is in use; it ends with this mount.
  const sidePanel = !!drawer.side;
  const { setSidePanel } = tabState;
  useLayoutEffect(() => {
    setSidePanel(sidePanel);
    return () => setSidePanel(false);
  }, [setSidePanel, sidePanel]);
  const selectPanelTab = (id: string) => {
    opening.current = panelTabs.find((entry) => tabId(entry) === id);
    tabState.select(id);
  };
  const afterClose = (id: string, trigger?: HTMLElement | null) => {
    if (id !== selectedTab) return;
    const index = rootTabIds.indexOf(id);
    const remaining = rootTabIds.filter((tab) => tab !== id);
    selectPanelTab(remaining[Math.min(index, remaining.length - 1)] ?? "");
    if (!remaining.length) {
      const target = trigger?.isConnected ? trigger : fallbackFocus?.current;
      if (target) target.focus({ preventScroll: true });
      else focusSplit.current = true;
    }
  };
  const closeConversationTab = (id: string) => {
    const closing = tabState.tabs.find((tab) => tab.id === id);
    const wasActive =
      closing && tabPane(closing) === "main"
        ? tabState.mainSelected === id
        : tabState.paneOpen && selectedTab === id;
    tabState.setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    // Once its pane empties, the page's own focus return (to the opener) is
    // the last word; until then focus stays with the remaining tabs.
    const notify = (last: boolean) => {
      if (closing?.kind === "thread")
        onCloseThread?.(closing, !!wasActive, last);
    };
    if (closing && tabPane(closing) === "main") {
      // The conversation remains; neighbours keep their order.
      const index = mainTabs.indexOf(closing);
      const remaining = mainTabs.filter((tab) => tab !== closing);
      if (tabState.mainSelected === id)
        tabState.selectMain(
          remaining[Math.min(index, remaining.length - 1)]?.id,
        );
      notify(!remaining.length);
      return;
    }
    afterClose(id);
    if (rootTabIds.length === 1) focusSplit.current = true;
    notify(rootTabIds.length === 1);
  };
  const [announcement, setAnnouncement] = useState("");
  // Place the tab and focus it where it landed in the same task. Reinserting
  // the tab's element blurs it, and a frame-deferred refocus would take focus
  // back from wherever the user has since moved it.
  const placeTab = (id: string, pane: TabPane, index: number) => {
    flushSync(() => tabState.moveTab(id, pane, index));
    document
      .querySelector<HTMLElement>(
        `[role="tab"][data-tab-value="${CSS.escape(id)}"]`,
      )
      ?.focus({ preventScroll: true });
  };
  // One keyboard gesture both reorders and crosses panes at an edge.
  const moveBy = (tab: Tab, delta: -1 | 1) => {
    if (!currentVisit() || tab.kind !== "thread") return;
    const pane = tabPane(tab);
    const order = pane === "main" ? mainTabs : sideTabs;
    const index = order.indexOf(tab);
    const crossing =
      mainThread(tab.channelId) &&
      ((pane === "main" && delta === 1 && index === order.length - 1) ||
        (pane === "side" && delta === -1 && index === 0));
    let target: TabPane = pane;
    let position = index + delta;
    if (crossing) {
      target = pane === "main" ? "side" : "main";
      position = target === "side" ? 0 : mainTabs.length;
    } else if (position < 0 || position >= order.length) return;
    placeTab(tab.id, target, position);
    setAnnouncement(
      crossing
        ? `Moved to the ${target === "main" ? "main" : "side"} pane.`
        : `Moved to position ${position + 1} of ${order.length}.`,
    );
  };
  const drag = useTabDrag({
    visit,
    navigationSignal,
    movable: new Set(
      tabState.tabs.filter((tab) => tab.kind === "thread").map((tab) => tab.id),
    ),
    order: new Set(tabState.tabs.map((tab) => tab.id)),
    closedSideIndex:
      mainPane &&
      (!tabState.paneOpen || (rootTabIds.length === 0 && !drawer.side))
        ? sideTabs.length
        : undefined,
    canMove: (id, pane) => {
      const tab = tabState.tabs.find((item) => item.id === id);
      return (
        currentVisit() &&
        tab?.kind === "thread" &&
        (pane === "side" || mainThread(tab.channelId))
      );
    },
    move: (id, pane, index) => {
      if (!currentVisit()) return;
      const moving = tabState.tabs.find((tab) => tab.id === id);
      const order = tabState.tabs.filter((tab) => tabPane(tab) === pane);
      if (moving && tabPane(moving) === pane && order.indexOf(moving) === index)
        return;
      placeTab(id, pane, index);
      setAnnouncement(`Moved to position ${index + 1} in the ${pane} pane.`);
    },
  });
  const openConversationThread = (
    channelId: string,
    messageId: string,
    rootId: string,
    intent?: "reply" | "reveal" | "focus",
  ) => {
    if (!currentVisit()) return;
    // Flat sessions keep their side-only host; channels support both panes.
    tabState.openThreadTab(
      channelId,
      messageId,
      rootId,
      intent,
      threadPane ?? (mainPane ? undefined : "side"),
    );
    if (
      opening.current &&
      panelTabId(opening.current) !== tabState.getSelected()
    )
      opening.current = undefined;
  };
  const openConversationLink = (
    channelId: string,
    url: string,
    origin?: MessageLinkOrigin,
  ) => {
    const connection = relay.snapshot();
    if (
      !active() ||
      connection.status !== "ready" ||
      connection.session !== queries
    )
      return false;
    const parsed = parseBuzzLink(url);
    if (
      parsed?.format === "legacy" &&
      !parsed.messageId &&
      queries.channels
        .list()
        .channels.some(
          (item) => item.id === parsed.channelId && item.channelType === "solo",
        )
    )
      return openLink(url);
    const next = panelOpening(panels, channelId, url, origin?.rootId);
    if (next) {
      panelTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      open(next, true);
      return true;
    }
    return openLink(url);
  };

  const nodes = useTabNodes(
    tabState.tabs.filter((tab) => tab.kind === "thread").map((tab) => tab.id),
  );
  function usableChannel(target: ChannelSummary) {
    return (
      !target.readOnly &&
      !target.archived &&
      !target.cached &&
      (target.channelType !== "solo" ||
        !!target.members?.includes(queries.viewer ?? ""))
    );
  }
  // The currently resolved channel can be a verified public/archived preview
  // absent from the joined sidebar list. Reading its thread is not write access.
  function tabChannel(tab: Pick<Tab, "kind" | "channelId">) {
    if (tab.kind === "thread" && current?.id === tab.channelId)
      return current.cached ? undefined : current;
    const target = channels.find((item) => item.id === tab.channelId);
    return target && usableChannel(target) ? target : undefined;
  }
  // Message rows are memoized: links read one stable opener that consults the
  // live workspace when chosen. Only current-channel threads use the main pane.
  const linkedThread = useRef<
    (channelId: string, messageId: string, rootId: string) => boolean
  >(() => false);
  useLayoutEffect(() => {
    linkedThread.current = (channelId, messageId, rootId) => {
      if (!currentVisit() || !tabChannel({ kind: "thread", channelId }))
        return false;
      tabState.openThreadTab(
        channelId,
        messageId,
        rootId,
        undefined,
        threadPane ?? (mainThread(channelId) ? undefined : "side"),
      );
      if (
        opening.current &&
        panelTabId(opening.current) !== tabState.getSelected()
      )
        opening.current = undefined;
      return true;
    };
  });
  const openLinkedThread = useCallback(
    (channelId: string, messageId: string, rootId: string) =>
      linkedThread.current(channelId, messageId, rootId),
    [],
  );
  // Several open threads stay distinguishable by their original message.
  function threadLabel(tab: Extract<Tab, { kind: "thread" }>, name?: string) {
    if (tab.name) return tab.name;
    const rootId = rootOfTab(tab);
    const root = queries.channels
      .window(tab.channelId)
      .rows.find((row) => row.id === rootId);
    const text = root?.content
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~>#]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return text || (name ? `Thread · ${name}` : "Thread");
  }
  function tabItem(tab: Tab) {
    const target = tabChannel(tab);
    const usable = !!target;
    return {
      id: tab.id,
      label:
        tab.kind === "thread"
          ? threadLabel(tab, target?.name)
          : (target?.name ?? "Unavailable conversation"),
      icon:
        tab.kind === "thread" ? (
          <MessageReplyIcon size="1rem" />
        ) : target ? (
          conversationIcon(target)
        ) : (
          <BrowserIcon size="1rem" />
        ),
      close: () => closeConversationTab(tab.id),
      ...(tab.kind === "thread" && {
        attentionRequest: tab.attentionRequest,
        move: (delta: -1 | 1) => moveBy(tab, delta),
        rename: (name: string) => tabState.renameTab(tab.id, name),
      }),
      // The current conversation's own threads are already in its channel.
      ...(target &&
        navigation &&
        viewer &&
        tab.channelId !== currentId && {
          actions: [
            {
              label: "Open in channel",
              run: () =>
                void navigation.open({
                  version: 1,
                  kind: "conversation",
                  scope: {
                    viewer,
                    communityOrigin: scope.slice(0, -(viewer.length + 1)),
                  },
                  channelId: tab.channelId,
                  ...(tab.messageId && { messageId: tab.messageId }),
                  ...(tab.kind === "thread" && {
                    threadRootId: rootOfTab(tab),
                  }),
                }),
            },
          ],
        }),
      content:
        !usable || !target ? (
          <p role="status" className={styles.empty}>
            This conversation is no longer available.
          </p>
        ) : tab.kind === "thread" && nodes.get(tab.id) ? (
          <TabSlot node={nodes.get(tab.id) as HTMLDivElement} />
        ) : (
          <ConversationTab
            focusOnMount={continuingVisit}
            active={tabState.paneOpen && selectedTab === tab.id}
            visit={visits}
            tab={tab}
            channel={target}
            session={queries}
            scope={scope}
            extensions={extensions}
            openLink={(url, origin) =>
              openConversationLink(target.id, url, origin)
            }
            canOpenLink={canOpenLink}
            openThread={(id, root, intent) =>
              openConversationThread(target.id, id, root, intent)
            }
            close={() => closeConversationTab(tab.id)}
          />
        ),
    };
  }

  // Close all tabs and Close other tabs: one store update for both panes,
  // including hidden tabs. False when the visit ended or nothing would
  // change: nothing to close and the kept tab already selected.
  const closeTabsExcept = (keep?: string) => {
    const closing = tabState.tabs.filter((tab) => tab.id !== keep);
    const kept = tabState.tabs.find((tab) => tab.id === keep);
    const unselected =
      kept && tabPane(kept) === "main"
        ? tabState.mainSelected !== keep
        : (!!kept ||
            tabState.entries.some((entry) => panelTabId(entry) === keep) ||
            (!!tabState.settings && keep === "settings")) &&
          !(tabState.paneOpen && selectedTab === keep);
    if (
      !currentVisit() ||
      navigationSignal?.aborted ||
      !(
        closing.length ||
        tabState.entries.some((entry) => panelTabId(entry) !== keep) ||
        (tabState.settings && keep !== "settings") ||
        tabState.thread ||
        unselected
      )
    )
      return false;
    const addressed = closing.find(
      (tab) =>
        tab.kind === "thread" &&
        routed?.channelId === tab.channelId &&
        routed.messageId === tab.messageId,
    );
    entryList.current = entryList.current.filter(
      (entry) => panelTabId(entry) === keep,
    );
    opening.current = entryList.current[0];
    tabState.closeTabs(keep);
    if (addressed?.kind === "thread") onCloseThread?.(addressed, false, true);
    return true;
  };

  return {
    open,
    opened,
    panel,
    panelTabs,
    selectOpening,
    selectPanelTab,
    afterClose,
    closePane: () => {
      if (!currentVisit()) return;
      focusSplit.current = true;
      tabState.setPaneOpen(false);
    },
    closeTab,
    closeAllTabs: () => closeTabsExcept(),
    closeOtherTabs: (id: string) => closeTabsExcept(id),
    selectedTab,
    drawer,
    drawerContext,
    splitTrigger,
    panelTrigger,
    openConversationLink,
    openConversationThread,
    openLinkedThread,
    /** Whether a tab for this conversation could show it. */
    canOpenConversation: (channelId: string) =>
      !!tabChannel({ kind: "conversation", channelId }),
    announcement,
    drag,
    mainItems: mainTabs.map(tabItem),
    selectedMain:
      mainTabs.find((tab) => tab.id === tabState.mainSelected)?.id ??
      "conversation",
    // Thread content renders here once and is attached to whichever pane holds it.
    hosts: tabState.tabs.flatMap((tab) => {
      if (tab.kind !== "thread") return [];
      const node = nodes.get(tab.id);
      const target = tabChannel(tab);
      if (!node || !target) return [];
      const active =
        tabPane(tab) === "main"
          ? tabState.mainSelected === tab.id
          : tabState.paneOpen && selectedTab === tab.id;
      const route =
        routed?.channelId === tab.channelId &&
        routed.messageId === tab.messageId
          ? routed.navigation
          : undefined;
      return [
        createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: Escape from the hosted thread closes its tab, as in the tab host.
          <div
            className={tabStyles.tabSlot}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                !event.defaultPrevented &&
                event.currentTarget.contains(event.target as Node)
              ) {
                event.stopPropagation();
                closeConversationTab(tab.id);
              }
            }}
          >
            <ConversationTab
              focusOnMount={continuingVisit}
              active={active}
              visit={visits}
              tab={tab}
              channel={target}
              session={queries}
              scope={scope}
              extensions={extensions}
              navigation={route}
              onRetryNavigation={onRetryNavigation}
              onResolvedRoot={(rootId) =>
                tabState.resolveThreadRoot(tab.id, rootId)
              }
              onDifferentThread={(requested, kept) =>
                tabState.divertThread(tab.id, requested, kept)
              }
              openLink={(url, origin) =>
                openConversationLink(target.id, url, origin)
              }
              canOpenLink={canOpenLink}
              openThread={(id, root, intent) =>
                openConversationThread(target.id, id, root, intent)
              }
              close={() => closeConversationTab(tab.id)}
            />
          </div>,
          node,
          tab.id,
        ),
      ];
    }),
    items: [
      ...sideTabs.map(tabItem),
      ...panelTabs.map((entry) => ({
        id: tabId(entry),
        instance: entry,
        label: entry.panel.title,
        ...(entry.channelContext && {
          icon: <InfoIcon size="1rem" />,
        }),
        close: () => closeTab(entry),
        content: (
          <PanelCard
            panel={entry.panel}
            target={entry.target}
            context={panelContext(entry)}
            channelContext={entry.channelContext}
            close={() => closeTab(entry)}
          />
        ),
      })),
    ],
  };
}
