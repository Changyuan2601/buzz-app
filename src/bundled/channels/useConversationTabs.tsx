import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { PanelCard } from "../../features/panels/PanelCard";
import { BrowserIcon } from "../../shared/design-system/icons";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import {
  ChannelTabPicker,
  channelToolIcon,
  isChannelTabTool,
} from "./ChannelTabPicker";
import { ConversationTab } from "./ConversationTab";
import { useChannelPanels } from "./useChannelPanels";
import {
  panelTabId,
  type PanelOpening,
  type useChannelTabState,
} from "./useChannelTabState";
import styles from "./Channels.module.css";

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
  isLive,
  openLink,
  fallbackFocus,
  eligible,
  threadId,
  onOpenDrawer,
  personalWorkspace = false,
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
  isLive(): boolean;
  openLink(url: string): boolean;
  fallbackFocus?: RefObject<HTMLElement | null>;
  eligible?(entry: PanelOpening): boolean;
  threadId?: string | undefined;
  personalWorkspace?: boolean | undefined;
  onOpenDrawer?(): void;
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
      const existing =
        append && next
          ? entryList.current.find(
              (entry) =>
                entry.panel === next.panel && entry.target === next.target,
            )
          : undefined;
      const selected = existing || next;
      // Timeline actions replace transient details, never retained channel tools.
      const retained = append
        ? entryList.current
        : entryList.current.filter(
            (entry) =>
              entry.channelContext &&
              (!selected || panelTabId(entry) !== panelTabId(selected)),
          );
      const updated =
        selected && !existing ? [...retained, selected] : retained;
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
      const next = panels.resolve(target);
      if (!next) return false;
      open({ channelId: entry.channelId, panel: next, target }, true);
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
  const drawer = useChannelPanels(
    panels,
    drawerContext,
    () => {
      onOpenDrawer?.();
      tabState.setPaneOpen(true);
    },
    (panel) => {
      const entry = panelTabs.find(
        (entry) => entry.panel === panel && entry.channelContext,
      );
      if (!entry) return false;
      if (tabState.paneOpen && tabState.selected === panelTabId(entry))
        tabState.setPaneOpen(false);
      else selectOpening(entry);
      return true;
    },
  );
  const tabTools =
    drawerContext && !current?.archived
      ? available.filter(isChannelTabTool)
      : [];
  const chooseTool = (id: string, panel: RegisteredPanel) => {
    const connection = relay.snapshot();
    if (
      connection.status !== "ready" ||
      connection.session !== queries ||
      !drawerContext ||
      !active() ||
      !tabTools.includes(panel) ||
      !panels.snapshot().includes(panel)
    )
      return;
    // A terminal's screen/session has one presentation owner at a time.
    drawer.close();
    panelTrigger.current = splitTrigger.current;
    tabState.setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    open(
      {
        panel,
        target: drawerContext.channelId,
        channelId: drawerContext.channelId,
        channelContext: drawerContext,
      },
      true,
    );
  };
  const tabDestinations = channels.filter(
    (item) =>
      item.id !== currentId &&
      !item.cached &&
      !item.readOnly &&
      item.channelType !== "session",
  );
  const rootTabIds = [
    ...leadingIds,
    ...tabState.tabs.map((tab) => tab.id),
    ...panelTabs.map(tabId),
  ];
  const selectedTab = rootTabIds.includes(tabState.selected)
    ? tabState.selected
    : (rootTabIds[0] ?? "");
  const selectPanelTab = (id: string) => {
    opening.current = panelTabs.find((entry) => tabId(entry) === id);
    tabState.select(id);
  };
  const afterClose = (id: string, trigger?: HTMLElement | null) => {
    if (id !== selectedTab) return;
    const index = rootTabIds.indexOf(id);
    const remaining = rootTabIds.filter((tab) => tab !== id);
    selectPanelTab(remaining[Math.min(index, remaining.length - 1)] ?? "");
    if (!remaining.length)
      (trigger?.isConnected
        ? trigger
        : (fallbackFocus?.current ?? splitTrigger.current)
      )?.focus({
        preventScroll: true,
      });
  };
  const addTab = () => {
    if (!currentVisit()) return;
    const id = `new:${crypto.randomUUID()}`;
    tabState.setTabs((tabs) => [...tabs, { id, kind: "new" }]);
    selectPanelTab(id);
  };
  const closeConversationTab = (id: string) => {
    tabState.setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    afterClose(id);
    if (rootTabIds.length === 1)
      splitTrigger.current?.focus({ preventScroll: true });
  };
  const chooseConversation = (id: string, channelId: string) => {
    // Recheck current membership at activation, not just the rendered search result.
    if (!currentVisit()) return;
    const target = queries.channels
      .list()
      .channels.find((item) => item.id === channelId);
    if (
      !target ||
      target.cached ||
      target.readOnly ||
      target.archived ||
      (target.channelType === "session" &&
        !target.members?.includes(queries.viewer ?? "")) ||
      channelId === currentId
    )
      return;
    const existing = tabState.tabs.find(
      (tab) => tab.kind === "conversation" && tab.channelId === channelId,
    );
    const targetId = `conversation:${channelId}`;
    tabState.setTabs((tabs) =>
      existing
        ? tabs.filter((tab) => tab.id !== id)
        : tabs.map((tab) =>
            tab.id === id
              ? { id: targetId, kind: "conversation", channelId }
              : tab,
          ),
    );
    selectPanelTab(existing?.id ?? targetId);
  };
  const openConversationThread = (
    channelId: string,
    messageId: string,
    rootId: string,
    intent?: "reply",
  ) => {
    if (!currentVisit()) return;
    const id = `thread:${channelId}:${rootId}`;
    tabState.setTabs((tabs) => {
      const existing = tabs.find((tab) => tab.id === id);
      const next = {
        id,
        kind: "thread" as const,
        channelId,
        messageId,
        replyRequest:
          intent === "reply"
            ? ((existing?.kind === "thread" ? existing.replyRequest : 0) ?? 0) +
              1
            : undefined,
      };
      return existing
        ? tabs.map((tab) => (tab.id === id ? next : tab))
        : [...tabs, next];
    });
    selectPanelTab(id);
  };
  const openConversationLink = (channelId: string, url: string) => {
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
          (item) =>
            item.id === parsed.channelId && item.channelType === "session",
        )
    )
      return openLink(url);
    const candidate = panels.resolve(url);
    if (candidate) {
      panelTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      open({ channelId, panel: candidate, target: url }, true);
      return true;
    }
    return openLink(url);
  };

  return {
    open,
    opened,
    panel,
    panelTabs,
    selectOpening,
    selectPanelTab,
    afterClose,
    addTab,
    closeTab,
    rootTabIds,
    selectedTab,
    drawer,
    drawerContext,
    splitTrigger,
    panelTrigger,
    openConversationLink,
    openConversationThread,
    items: [
      ...tabState.tabs.map((tab) => {
        const target =
          tab.kind === "new"
            ? undefined
            : channels.find((item) => item.id === tab.channelId);
        const usable =
          target &&
          !target.readOnly &&
          !target.archived &&
          !target.cached &&
          (target.channelType !== "session" ||
            target.members?.includes(queries.viewer ?? ""));
        return {
          id: tab.id,
          label:
            tab.kind === "new"
              ? "New tab"
              : tab.kind === "thread"
                ? `Thread · ${target?.name ?? "Unavailable"}`
                : (target?.name ?? "Unavailable conversation"),
          icon: target ? conversationIcon(target) : <BrowserIcon size="1rem" />,
          close: () => closeConversationTab(tab.id),
          content:
            tab.kind === "new" ? (
              <ChannelTabPicker
                channels={tabDestinations}
                tools={tabTools}
                chooseTool={(panel) => chooseTool(tab.id, panel)}
                icon={conversationIcon}
                usageScope={scope}
                choose={(channelId) => chooseConversation(tab.id, channelId)}
              />
            ) : usable ? (
              <ConversationTab
                personalWorkspace={personalWorkspace}
                focusOnMount={continuingVisit}
                active={tabState.paneOpen && selectedTab === tab.id}
                tab={tab}
                channel={target}
                session={queries}
                scope={scope}
                extensions={extensions}
                openLink={(url) => openConversationLink(target.id, url)}
                canOpenLink={canOpenLink}
                openThread={(id, root, intent) =>
                  openConversationThread(target.id, id, root, intent)
                }
                close={() => closeConversationTab(tab.id)}
              />
            ) : (
              <p role="status" className={styles.empty}>
                This conversation is no longer available.
              </p>
            ),
        };
      }),
      ...panelTabs.map((entry) => ({
        id: tabId(entry),
        instance: entry,
        label: entry.panel.title,
        ...(entry.channelContext && {
          icon: channelToolIcon(entry.panel),
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
