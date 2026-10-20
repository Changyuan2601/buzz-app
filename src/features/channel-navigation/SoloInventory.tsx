import {
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { useChannelNavigation } from "./ChannelNavigationState";
import { conversationTarget, soloDraftTarget } from "./routes";
import { ChannelActivityPopover } from "../../bundled/channels/ChannelActivityPopover";
import { useWorkingAgents } from "../../bundled/channels/useWorkingAgents";
import { WorkingAgentsBadge } from "../../bundled/channels/WorkingAgentsBadge";
import { UnreadBadge } from "../../bundled/channels/UnreadBadge";
import { SoloWorkspaces } from "../../bundled/channels/SoloWorkspaces";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { useRecoveryShown } from "../relay/RecoveryNotice";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { ownSolo } from "../solo/labels";
import { resetNewChatProject } from "../solo/SoloDraft";
import { NewWorkspace } from "../solo/NewWorkspace";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import creationStyles from "./SoloInventory.module.css";
import { PlusIcon, ChatCircleIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import channelStyles from "../../bundled/channels/Channels.module.css";
import styles from "../../bundled/channels/SoloWorkspaces.module.css";

/** Solo projects and conversations: the owner's private filing of ordinary channels. */
export function SoloInventory({
  session,
  scope,
  navigator,
  target,
}: {
  session: RelaySession;
  scope: string;
  navigator: Navigation;
  target: OpenTarget;
}) {
  const list = useChannelList(session.channels);
  const preferences = useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const recoveryShown = useRecoveryShown(session.recovery);
  const selected =
    target.kind === "conversation" ? target.channelId : undefined;
  const handoff = useChannelNavigation();
  const workingIds = useSyncExternalStore(
    session.agentActivity.subscribeWorking,
    session.agentActivity.workingSnapshot,
    session.agentActivity.workingSnapshot,
  );
  const workingChannels = new Set<string>(JSON.parse(workingIds));
  const open = (channelId: string) =>
    navigator.open(conversationTarget(scope, channelId));
  const openMessage = (channelId: string, messageId?: string) => {
    if (handoff && handoff.session !== session) return;
    const destination =
      messageId && session.viewer
        ? buzzLinkTarget(
            `buzz://message?channel=${channelId}&id=${messageId}`,
            {
              viewer: session.viewer,
              communityOrigin: scope.slice(0, -(session.viewer.length + 1)),
            },
          )
        : conversationTarget(scope, channelId);
    if (destination) void navigator.open(destination);
  };
  const openAgentActivity = (channelId: string, agent: string) => {
    if (!handoff || handoff.session !== session) return;
    const intent = {
      channelId,
      agent,
      trigger: document.querySelector<HTMLElement>(
        `[data-solo-channel-id="${CSS.escape(channelId)}"]`,
      ),
    };
    handoff.activityAgent.current = intent;
    void open(channelId).then(() => {
      if (handoff.activityAgent.current === intent)
        handoff.activityAgent.current = undefined;
    });
  };
  const conversations = list.channels
    .filter((item) => !item.archived && ownSolo(item, session.viewer))
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
          (a.lastActivityAt ?? a.updatedAt ?? 0) || a.id.localeCompare(b.id),
    );
  const empty =
    list.status === "ready" &&
    preferences.status === "ready" &&
    !conversations.length &&
    !preferences.data?.sections.length;
  const current = () => !handoff || handoff.session === session;
  const newChat = (project?: string) => {
    if (!current()) return;
    if (project) resetNewChatProject(scope, project);
    void navigator.open(soloDraftTarget(scope, project ? { project } : {}));
  };
  return (
    <nav className={styles.sidebarContents} aria-label="Solo conversations">
      <div
        className={creationStyles.header}
        data-actions-visible={menuOpen || undefined}
      >
        <InlineHeader
          title={<span className="text-standard">Solo</span>}
          actions={
            <div className={creationStyles.actions}>
              <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
                <MenuTrigger
                  render={
                    <IconButton
                      ref={trigger}
                      size="compact"
                      aria-label="New in Solo"
                      title="New in Solo"
                      icon={<PlusIcon size={15} strokeWidth={2.5} />}
                    />
                  }
                />
                <MenuPopup align="end">
                  <MenuItem onClick={() => newChat()}>New chat</MenuItem>
                  <MenuItem
                    disabled={!session.soloPreferences.sectionCreationWritable}
                    onClick={() => {
                      if (current()) setCreatingProject(true);
                    }}
                  >
                    New workspace…
                  </MenuItem>
                </MenuPopup>
              </MenuRoot>
            </div>
          }
        />
      </div>
      {empty && (
        <NavigationItem
          variant="row"
          label="New chat"
          icon={<PlusIcon size={16} />}
          onClick={() => newChat()}
        />
      )}
      {creatingProject && (
        <NewWorkspace
          session={session}
          create={(section) => session.soloPreferences.createSection(section)}
          close={() => setCreatingProject(false)}
          finalFocus={trigger}
          onCreated={(id) => {
            if (trigger.current?.isConnected) newChat(id);
          }}
        />
      )}
      <SoloWorkspaces
        navigator={navigator}
        visit={navigator.snapshot().attempt.signal}
        session={session}
        scope={scope}
        onConverted={(channelId) => {
          if (handoff && handoff.session !== session) return;
          void open(channelId).then((result) => {
            if (result.status !== "opened") return;
            document
              .querySelector<HTMLElement>(
                `[data-channel-workspace="${CSS.escape(channelId)}"] form [role="textbox"]`,
              )
              ?.focus({ preventScroll: true });
          });
        }}
        chats={conversations.map((item) => ({
          id: item.id,
          title: item.name,
        }))}
        onNew={newChat}
        renderChat={(item) => (
          <SoloConversationRow
            key={item.id}
            session={session}
            id={item.id}
            title={item.title}
            selected={selected === item.id}
            working={workingChannels.has(item.id)}
            onSelect={() => void open(item.id)}
            onOpenThread={(thread) =>
              openMessage(thread.channelId, thread.rootId)
            }
            onOpenWorkingAgent={(id, _agent, messageId) => {
              if (messageId) openMessage(id, messageId);
              else void open(id);
            }}
            onOpenAgentActivity={openAgentActivity}
          />
        )}
      />
      {list.status === "loading" && <p role="status">Loading conversations…</p>}
      {list.status === "error" && !recoveryShown && (
        <p role="alert">{list.error}</p>
      )}
    </nav>
  );
}

function SoloConversationRow({
  session,
  id,
  title,
  selected,
  working,
  onSelect,
  onOpenThread,
  onOpenWorkingAgent,
  onOpenAgentActivity,
}: {
  session: RelaySession;
  id: string;
  title: string;
  selected: boolean;
  working: boolean;
  onSelect: () => void;
} & Pick<
  ComponentProps<typeof ChannelActivityPopover>,
  "onOpenThread" | "onOpenWorkingAgent" | "onOpenAgentActivity"
>) {
  const { agents, agentProfiles, waiting } = useWorkingAgents(
    session,
    id,
    working,
  );
  return (
    <ChannelActivityPopover
      session={session}
      channelId={id}
      channelName={title}
      agents={agents}
      agentProfiles={agentProfiles}
      onOpenThread={onOpenThread}
      {...(onOpenWorkingAgent ? { onOpenWorkingAgent } : {})}
      {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
      trigger={
        <NavigationItem
          type="button"
          selected={selected}
          data-solo-channel-id={id}
          aria-current={selected ? "page" : undefined}
          onClick={onSelect}
          icon={
            <span className={styles.conversationIcon} aria-hidden="true">
              <ChatCircleIcon size={16} />
            </span>
          }
          label={
            <span className={styles.chatRow}>
              <UnreadBadge
                session={session}
                channelId={id}
                label={title}
                labelUnread="all"
              />
            </span>
          }
          trailing={
            <span
              className={channelStyles.indicatorStack}
              data-solo-working-indicator=""
            >
              <WorkingAgentsBadge
                agents={agents}
                profiles={agentProfiles}
                channelName={title}
                waiting={waiting}
              />
            </span>
          }
        />
      }
    />
  );
}
