import {
  conversionLabel,
  useSessionConversions,
} from "../../features/sessions/conversion";
import {
  sessionShareAttempt,
  useSessionShareAttempts,
} from "../../features/sessions/share-attempt";
import {
  ConvertSession,
  canConvertSession,
} from "../../features/sessions/ConvertSession";
import { profileActivityViewTarget } from "../../features/profiles/target";
import { canEditSessionLifetime } from "../../features/sessions/SessionLifetime";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { useConversationTabs } from "../channels/useConversationTabs";
import { useChannelTabState } from "../channels/useChannelTabState";
import { useChannelLabels } from "../channels/useChannelLabels";
import panelStyles from "../../features/panels/Panels.module.css";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import type { Panels } from "../../features/panels/service";
import { SidebarRightIcon } from "../../shared/design-system/icons";
import { channelIcon } from "../../features/channels/channel-icon";
import channelStyles from "../channels/Channels.module.css";
import { SessionShare } from "./SessionShare";
import { ChannelMembersButton } from "../channels/ChannelMembersDialog";
import { pendingSessionDraft } from "../../features/sessions/pending-start";
import { WorkspaceSettings } from "../../features/sessions/WorkspaceSettings";
import { ChannelLifecycleDialog } from "../channels/ChannelLifecycleDialog";
import { ChannelLifecycleMenu } from "../channels/ChannelLifecycleMenu";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { DotsThreeIcon, GearIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { useRecoveryShown } from "../../features/relay/RecoveryNotice";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PageNavigation } from "../../features/navigation/service";
import { useMePlacement } from "../../features/sessions/personal";
import { meSelection, meSection, meTarget } from "../me/routes";
import { subscribeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import type { MessageLinkOrigin } from "../../features/messages/MessageRow";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import { SessionAgentControl } from "../../features/sessions/SessionAgentControl";
import { SessionProjectControl } from "../../features/sessions/SessionProjectControl";
import {
  readSelectedAssistant,
  writeSelectedAssistant,
} from "../../features/sessions/selected-assistant";
import {
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import styles from "../../features/sessions/Sessions.module.css";

/** The open chat's Archive, published for the Me shortcut while its visit is live. */
export type ArchiveShortcut = {
  current?: { available(): boolean; run(): Promise<void> } | undefined;
};

export function SessionsPage({
  relay,
  panels,
  companion,
  extensions,
  navigator,
  navigation,
  archive,
}: {
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
  navigation?: PageNavigation | undefined;
  archive?: ArchiveShortcut | undefined;
}) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <LiveSessions
      key={`${connection.scope}:${connection.generation}`}
      relay={relay}
      panels={panels}
      companion={companion}
      session={connection.session}
      scope={connection.scope ?? ""}
      extensions={extensions}
      navigator={navigator}
      navigation={navigation?.forSession(relay, connection)}
      archive={archive}
    />
  ) : (
    <PanelFrame companion={companion}>
      <section className={styles.empty} aria-label="Solo">
        <ChatCircleIcon size={28} />
        <h1>Solo</h1>
        <p>
          {connection.status === "connecting"
            ? "Connecting to your community…"
            : "Connect to a community to work with your agents."}
        </p>
        {connection.status === "error" && (
          <>
            <p role="alert">{connection.error ?? "The connection failed."}</p>
            <Button type="button" onClick={relay.retry}>
              Retry connection
            </Button>
          </>
        )}
      </section>
    </PanelFrame>
  );
}

type LiveProps = {
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
  session: RelaySession;
  scope: string;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
  navigation?: PageNavigation | undefined;
  archive?: ArchiveShortcut | undefined;
};
type Lifecycle = {
  channel: ChannelSummary;
  action: ChannelLifecycleAction;
  trigger?: HTMLElement | undefined;
  origin?: AbortSignal | undefined;
};

// Lifecycle actions remove the conversation from Me, so the dialog outlives
// the view but not the visit that opened it.
function LiveSessions(props: LiveProps) {
  const { session, scope, navigator } = props;
  const [lifecycle, setLifecycle] = useState<Lifecycle>();
  return (
    <>
      <SessionsView {...props} chooseLifecycle={setLifecycle} />
      {lifecycle && !lifecycle.origin?.aborted && (
        <ChannelLifecycleDialog
          channelId={lifecycle.channel.id}
          channelName={lifecycle.channel.name}
          action={lifecycle.action}
          lifecycle={session.channelLifecycle}
          close={() => {
            setLifecycle(undefined);
            if (lifecycle.trigger?.isConnected)
              lifecycle.trigger.focus({ preventScroll: true });
          }}
          completed={() => {
            setLifecycle(undefined);
            if (!lifecycle.origin?.aborted)
              void navigator?.open(meTarget(scope));
          }}
        />
      )}
    </>
  );
}

function SessionsView({
  relay,
  panels,
  companion,
  session,
  scope,
  extensions,
  navigator,
  navigation,
  archive,
  chooseLifecycle,
}: LiveProps & { chooseLifecycle(lifecycle: Lifecycle): void }) {
  const list = useChannelList(session.channels);
  const placement = useMePlacement(session);
  const selected = meSelection(navigation?.target);
  const newSection = meSection(navigation?.target);
  const pendingDraft = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () =>
      selected !== "new" ? pendingSessionDraft(scope, selected) : undefined,
  );
  const selectedSession = list.channels.find((item) => item.id === selected);
  const select = (id: string) => {
    void navigator?.open(meTarget(scope, id));
  };
  // Mail's Archive chord opens the same confirmation as the Session actions menu.
  const archivable =
    selected !== "new" &&
    !pendingDraft &&
    !selectedSession?.readOnly &&
    !selectedSession?.cached &&
    !selectedSession?.archived
      ? selectedSession
      : undefined;
  const lifecycle = session.channelLifecycle;
  // Chat activity replaces the summary; a pending request belongs to the chat.
  const latest = useRef(archivable);
  useLayoutEffect(() => {
    latest.current = archivable;
  });
  const archivableId = archivable?.id;
  useLayoutEffect(() => {
    if (!archive || !archivableId || !lifecycle.available) return;
    const signal = navigation?.signal;
    const current = {
      available: () => !signal?.aborted,
      // The menu's fresh permission read: no Archive where the menu has none.
      run: async () => {
        const trigger =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
        const settings = await lifecycle
          .load(archivableId, signal)
          .catch(() => undefined);
        const channel = latest.current;
        if (
          settings?.canArchive &&
          archive.current === current &&
          channel?.id === archivableId
        )
          chooseLifecycle({
            channel,
            action: "archive",
            trigger,
            origin: signal,
          });
      },
    };
    archive.current = current;
    return () => {
      if (archive.current === current) archive.current = undefined;
    };
  }, [archive, archivableId, lifecycle, navigation, chooseLifecycle]);
  if (selected === "new" || pendingDraft)
    return (
      <PanelFrame companion={companion}>
        <NewSessionComposer
          personal={
            !pendingDraft ||
            pendingDraft === "me" ||
            pendingDraft.startsWith("me:")
          }
          standalone
          focusRequest={
            navigation?.focus === "preserve" ? 0 : (navigation?.signal ?? 0)
          }
          key={pendingDraft ?? newSection ?? "unfiled"}
          resumeDraftKey={pendingDraft}
          sectionId={
            pendingDraft?.includes(":section:")
              ? pendingDraft.split(":section:")[1]
              : newSection
          }
          extensions={extensions}
          session={session}
          scope={scope}
          onStarted={(id) => {
            if (navigation?.signal.aborted) return;
            if (!session.mePlacement.has(id)) {
              const target = meTarget(scope);
              if (target.kind === "page" && target.scope)
                void navigator?.open({
                  version: 1,
                  kind: "conversation",
                  scope: target.scope,
                  channelId: id,
                });
            } else select(id);
          }}
        />
      </PanelFrame>
    );
  if (selectedSession)
    return (
      <SessionWork
        chooseLifecycle={(action, trigger) =>
          chooseLifecycle({
            channel: selectedSession,
            action,
            trigger,
            origin: navigation?.signal,
          })
        }
        relay={relay}
        panels={panels}
        companion={companion}
        key={`${selectedSession.id}:${navigation?.entryId ?? ""}`}
        session={session}
        scope={scope}
        channel={selectedSession}
        navigation={navigation}
        extensions={extensions}
        navigator={navigator}
      />
    );
  return (
    <PanelFrame companion={companion}>
      <section className={styles.empty}>
        {placement.status !== "ready" ? (
          <p role="status">{placement.error ?? "Loading Solo chats…"}</p>
        ) : list.status === "loading" ? (
          <p role="status">Loading your conversation…</p>
        ) : (
          <>
            <p>This conversation isn’t in Solo. Open it in Multiplayer.</p>
            {selectedSession && (
              <Button
                onClick={() => {
                  const target = meTarget(scope);
                  if (target.kind === "page" && target.scope)
                    void navigator?.open({
                      version: 1,
                      kind: "conversation",
                      scope: target.scope,
                      channelId: selected,
                    });
                }}
              >
                Open in Multiplayer
              </Button>
            )}
            <Button
              onClick={() => {
                session.channels.refreshList?.();
              }}
            >
              Retry
            </Button>
          </>
        )}
      </section>
    </PanelFrame>
  );
}

function SessionWork({
  relay,
  panels,
  companion,
  session,
  scope,
  channel,
  extensions,
  parentName,
  navigator,
  navigation,
  chooseLifecycle,
}: {
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions: ConversationExtensions;
  parentName?: string | undefined;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  chooseLifecycle(action: ChannelLifecycleAction, trigger?: HTMLElement): void;
}) {
  useSessionConversions(session);
  const window = useChannelWindow(session.channels, channel.id);
  const recoveryShown = useRecoveryShown(session.recovery);
  const [sent, setSent] = useState<string>();
  const [convertOpen, setConvertOpen] = useState(false);
  const shareAttempts = useSessionShareAttempts(session);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState<{
    visit: AbortSignal | undefined;
  }>();
  const [selectedAgent, setSelectedAgent] = useState(() =>
    readSelectedAssistant(scope, channel.id),
  );
  const selectAgent = (agent: string) => {
    setSelectedAgent(agent);
    writeSelectedAssistant(scope, channel.id, agent);
  };
  const placement = useMePlacement(session);
  const inMe = placement.ids.includes(channel.id);
  const personalChat = inMe && channel.channelType === "session";
  const list = useChannelList(session.channels);
  const { channels } = useChannelLabels(
    list.channels,
    session.profiles,
    session.names,
  );
  const tabState = useChannelTabState(session, channel.id, "me");
  const mounted = useRef(false);
  const continuing = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    continuing.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const focusFallback = useRef<HTMLElement>(null);
  const secondary = useConversationTabs({
    fallbackFocus: focusFallback,
    state: tabState,
    relay,
    session,
    panels,
    current: channel,
    scope,
    channels,
    extensions,
    leadingIds: [],
    continuingVisit: continuing.current,
    navigationSignal: navigation?.signal,
    isLive: () => !navigation?.signal.aborted,
    openLink: (url) => openLink(url),
    conversationIcon: (item) => {
      const Icon = channelIcon(item);
      return <Icon size="1rem" />;
    },
  });
  const { drawer, splitTrigger } = secondary;
  const handoff = useChannelNavigation();
  const { open, panelTrigger } = secondary;
  useLayoutEffect(() => {
    const intent = handoff?.activityAgent.current;
    if (
      !intent ||
      intent.channelId !== channel.id ||
      navigation?.signal.aborted
    )
      return;
    const target = profileActivityViewTarget(intent.agent);
    const panel = target && panels.resolve(target);
    if (target && panel) {
      panelTrigger.current = intent.trigger;
      open({ channelId: intent.channelId, panel, target }, true);
    }
    handoff.activityAgent.current = undefined;
  }, [handoff, channel.id, navigation, panels, open, panelTrigger]);

  const canOpenLink = (url: string) =>
    !!panels.resolve(url) ||
    (!!navigator && !!sessionLinkTarget(url, scope, session.viewer));
  function openLink(url: string, origin?: MessageLinkOrigin) {
    const connection = relay.snapshot();
    if (
      !mounted.current ||
      navigation?.signal.aborted ||
      connection.status !== "ready" ||
      connection.session !== session
    )
      return false;
    const target = sessionLinkTarget(url, scope, session.viewer);
    if (target) {
      if (!navigator) return false;
      void navigator.open(target);
      return true;
    }
    const panel = panels.resolve(url);
    if (!panel) return false;
    secondary.panelTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    secondary.open({
      channelId: channel.id,
      ...(origin && { rootId: origin.rootId }),
      panel,
      target: url,
    });
    return true;
  }
  useEffect(
    () => () => tabState.retireMenuEntries(),
    [tabState.retireMenuEntries],
  );
  const split = usePanelSplit();
  const hasTabs = secondary.items.length > 0;
  const hasLocalPanel = hasTabs || !!drawer.side;
  const showingPanel = tabState.paneOpen && hasLocalPanel;
  const workspace = (
    <div className={channelStyles.root}>
      <div ref={split.ref} style={split.style} className={channelStyles.board}>
        <section
          ref={focusFallback}
          aria-label={`Chat ${channel.name}`}
          tabIndex={-1}
          className={styles.work}
          data-attachment-drop-zone=""
          onDragOver={rejectUnhandledFileDrop}
          onDrop={rejectUnhandledFileDrop}
        >
          <SessionHeading channel={channel} parentName={parentName}>
            <ChannelMembersButton session={session} channelId={channel.id} />
            {drawer.launchers}
            <SessionShare
              session={session}
              channel={channel}
              signal={navigation?.signal}
              onConverted={() => openLink(`buzz://channel/${channel.id}`)}
            />
            <IconButton
              ref={settingsTrigger}
              size="toolbar"
              aria-label="Session settings"
              title="Session settings"
              icon={<GearIcon size="1rem" aria-hidden="true" />}
              disabled={
                !!channel.readOnly ||
                (!session.canvas.available &&
                  !canEditSessionLifetime(session, channel))
              }
              onClick={() => setSettingsOpen({ visit: navigation?.signal })}
            />
            {!channel.readOnly && !channel.cached && !channel.archived && (
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      ref={actionsTrigger}
                      size="toolbar"
                      aria-label="Session actions"
                      title="Session actions"
                      icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
                    />
                  }
                />
                <MenuPopup aria-label="Session actions" align="end">
                  {canConvertSession(session, channel) && (
                    <MenuItem
                      disabled={shareAttempts.has(channel.id)}
                      onClick={() => {
                        if (!sessionShareAttempt(session, channel.id))
                          setConvertOpen(true);
                      }}
                    >
                      {conversionLabel(session, channel.id)}
                    </MenuItem>
                  )}
                  <ChannelLifecycleMenu
                    channelId={channel.id}
                    lifecycle={session.channelLifecycle}
                    disabled={false}
                    separator={canConvertSession(session, channel)}
                    choose={(action) =>
                      chooseLifecycle(
                        action,
                        actionsTrigger.current ?? undefined,
                      )
                    }
                  />
                </MenuPopup>
              </MenuRoot>
            )}
            {hasLocalPanel && !showingPanel && (
              <span className={panelStyles.paneToggle}>
                <IconButton
                  ref={splitTrigger}
                  data-tab-pane-toggle=""
                  size="toolbar"
                  aria-label="Toggle tab pane"
                  title="Open tab pane"
                  aria-expanded={false}
                  icon={<SidebarRightIcon size="1rem" />}
                  onClick={() => tabState.setPaneOpen(!showingPanel)}
                />
              </span>
            )}
          </SessionHeading>
          {convertOpen && (
            <ConvertSession
              key={channel.id}
              session={session}
              id={channel.id}
              signal={navigation?.signal}
              onConverted={() => openLink(`buzz://channel/${channel.id}`)}
              close={() => setConvertOpen(false)}
              finalFocus={actionsTrigger}
            />
          )}
          {settingsOpen && (
            <WorkspaceSettings
              signal={settingsOpen.visit}
              finalFocus={settingsTrigger}
              key={channel.id}
              session={session}
              scope={scope}
              target={{ kind: "session", id: channel.id, name: channel.name }}
              close={() => setSettingsOpen(undefined)}
            />
          )}
          {placement.status === "error" && !placement.transient ? (
            <p role="status">
              {placement.error}{" "}
              <Button onClick={() => void session.mePlacement.refresh()}>
                Retry Solo
              </Button>
            </p>
          ) : (
            placement.status !== "ready" && (
              <p role="status">Loading Solo chats…</p>
            )
          )}
          {!inMe && placement.status === "ready" && (
            <div role="status">
              <p>This conversation is in Multiplayer.</p>
              {navigator && (
                <Button
                  onClick={() => openLink(`buzz://channel/${channel.id}`)}
                >
                  Open in Multiplayer
                </Button>
              )}
            </div>
          )}
          <SessionColumn enabled={false}>
            <MessageManagementStatus />
            <div className={styles.timeline}>
              {window.status === "error" &&
              !window.rows.length &&
              !recoveryShown ? (
                <div className={styles.empty} role="alert">
                  <p>{window.error}</p>
                  <Button
                    type="button"
                    onClick={() => session.channels.ensure(channel.id)}
                  >
                    Retry messages
                  </Button>
                </div>
              ) : window.status !== "ready" && !window.rows.length ? (
                <p className={styles.empty} role="status">
                  Loading messages…
                </p>
              ) : (
                <ChannelTimeline
                  chatPresentation={personalChat}
                  historyControl="scroll"
                  extensions={extensions}
                  queries={session}
                  viewer={session.viewer}
                  scope={scope}
                  channelId={channel.id}
                  window={window}
                  revealMessageId={sent}
                  onOpenLink={openLink}
                  canOpenLink={canOpenLink}
                />
              )}
            </div>
            <MessageComposer
              chatPresentation={personalChat}
              sessionConversation={channel.channelType === "session"}
              activityClickOpensPanel
              personalConversation={
                channel.channelType === "session" &&
                (placement.status !== "ready" || inMe)
              }
              selectedAgent={personalChat ? selectedAgent : undefined}
              trailingTool={
                personalChat ? (
                  <>
                    <SessionAgentControl
                      session={session}
                      channelId={channel.id}
                      value={selectedAgent}
                      onChange={selectAgent}
                      disabled={
                        !!channel.archived || placement.status !== "ready"
                      }
                    />
                    <SessionProjectControl
                      session={session}
                      channelId={channel.id}
                      disabled={
                        !!channel.archived || placement.status !== "ready"
                      }
                    />
                  </>
                ) : undefined
              }
              onSend={setSent}
              extensions={extensions}
              session={session}
              scope={scope}
              channelId={channel.id}
              channelName={channel.name}
              label={
                channel.channelType === "session"
                  ? "Message your agents"
                  : undefined
              }
              disabled={
                !!channel.archived ||
                window.status !== "ready" ||
                placement.status !== "ready"
              }
              onOpenLink={openLink}
              canOpenLink={canOpenLink}
            />
          </SessionColumn>
          {drawer.content}
        </section>
        <PanelDock
          open={!!companion || !!showingPanel}
          keepMounted={hasLocalPanel && !tabState.paneOpen}
          className={channelStyles.panelStack}
          resizeHandle={split.handle}
        >
          {hasTabs && (
            <div
              className={channelStyles.retainedPanel}
              hidden={!!companion && !showingPanel}
            >
              {secondary.drag.feedback}
              {secondary.hosts}
              <PanelWorkspace
                drag={secondary.drag.side}
                actions={
                  <IconButton
                    data-tab-pane-toggle=""
                    data-highlight-expanded="false"
                    variant="subtle"
                    size="toolbar"
                    aria-label="Toggle tab pane"
                    title="Close tab pane"
                    aria-expanded={true}
                    onClick={secondary.closePane}
                    icon={<SidebarRightIcon size="1rem" aria-hidden="true" />}
                  />
                }
                value={secondary.selectedTab}
                select={secondary.selectPanelTab}
                items={secondary.items}
                focusOnMount={continuing.current}
              />
            </div>
          )}
          {drawer.side && (
            <div
              className={channelStyles.retainedPanel}
              hidden={!!companion && !showingPanel}
            >
              {drawer.side}
            </div>
          )}
          {companion && (
            <div key="companion" className={channelStyles.companion}>
              {companion}
            </div>
          )}
        </PanelDock>
      </div>
    </div>
  );
  return (
    <MessageManagement session={session} channelId={channel.id}>
      {workspace}
    </MessageManagement>
  );
}

export function sessionLinkTarget(
  url: string,
  scope: string,
  viewer: string | undefined,
): ReturnType<typeof buzzLinkTarget> {
  if (!viewer || !isBuzzLink(url)) return null;
  return buzzLinkTarget(url, {
    viewer,
    communityOrigin: scope.slice(0, -(viewer.length + 1)),
  });
}
