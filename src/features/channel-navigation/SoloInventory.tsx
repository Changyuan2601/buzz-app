import { useSyncExternalStore, type ComponentProps } from "react";
import { useChannelNavigation } from "./ChannelNavigationState";
import { conversationTarget, soloDraftTarget } from "./routes";
import { ChannelActivityPopover } from "../../bundled/channels/ChannelActivityPopover";
import { useWorkingAgents } from "../../bundled/channels/useWorkingAgents";
import { WorkingAgentsBadge } from "../../bundled/channels/WorkingAgentsBadge";
import { UnreadBadge } from "../../bundled/channels/UnreadBadge";
import { SoloProjects } from "../../bundled/channels/SoloProjects";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { useRecoveryShown } from "../relay/RecoveryNotice";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { ownSolo } from "../solo/labels";
import { resetNewChatProject } from "../solo/SoloDraft";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import channelStyles from "../../bundled/channels/Channels.module.css";
import styles from "../../bundled/channels/SoloProjects.module.css";

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
  return (
    <nav className={styles.sidebarContents} aria-label="Solo conversations">
      <SoloProjects
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
        onNew={(project) => {
          if (project) resetNewChatProject(scope, project);
          void navigator.open(
            soloDraftTarget(scope, project ? { project } : {}),
          );
        }}
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
      {!conversations.length && list.status === "ready" && (
        <p className={styles.listMessage}>
          Start a conversation with your agents.
        </p>
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
              <UnreadBadge session={session} channelId={id} label={title} />
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
