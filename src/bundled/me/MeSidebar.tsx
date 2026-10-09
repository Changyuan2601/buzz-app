import { sessionLinkTarget } from "../sessions/SessionsPage";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { useMePlacement } from "../../features/sessions/personal";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SessionSections } from "../sessions/SessionSections";
import { readChannelSidebarWidth } from "../channels/useSidebarView";
import { UnreadBadge } from "../channels/UnreadBadge";
import { meSelection, meTarget } from "./routes";
import styles from "../sessions/SessionsWorkspace.module.css";

type Props = { relay: RelayData; navigator: Navigation; target: OpenTarget };
export function MeSidebar({ relay, navigator, target }: Props) {
  const connection = useRelayConnection(relay);
  const scope = connection.scope ?? "disconnected";
  const width = readChannelSidebarWidth(scope);
  return (
    <div className="shell-sidebar-default" style={{ width }}>
      <SidebarFrame label="Me sidebar">
        {connection.status === "ready" ? (
          <PersonalHistory
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={scope}
            navigator={navigator}
            target={target}
          />
        ) : (
          <p role="status">Connect to a community to see your conversations.</p>
        )}
      </SidebarFrame>
    </div>
  );
}

function PersonalHistory({
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
  const placement = useMePlacement(session);
  const selected = meSelection(target);
  const conversations = list.channels
    .filter((item) => !item.archived && placement.ids.includes(item.id))
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
          (a.lastActivityAt ?? a.updatedAt ?? 0) || a.id.localeCompare(b.id),
    );
  return (
    <nav
      className={`${styles.sidebar} ${styles.history}`}
      aria-label="Me conversations"
    >
      <SessionSections
        personal
        visit={navigator.snapshot().attempt.signal}
        session={session}
        scope={scope}
        sessions={conversations.map((item) => ({
          id: item.id,
          title: item.name,
        }))}
        onShared={(id) => {
          const destination = sessionLinkTarget(
            `buzz://channel/${id}`,
            scope,
            session.viewer,
          );
          if (destination) void navigator.open(destination);
        }}
        onNew={(sectionId) =>
          void navigator.open(meTarget(scope, "new", sectionId))
        }
        renderSession={(item) => (
          <NavigationItem
            key={item.id}
            type="button"
            selected={selected === item.id}
            aria-current={selected === item.id ? "page" : undefined}
            onClick={() => void navigator.open(meTarget(scope, item.id))}
            label={
              <span className={styles.sessionRow}>
                <UnreadBadge
                  session={session}
                  channelId={item.id}
                  label={item.title}
                />
              </span>
            }
          />
        )}
      />
      {list.status === "loading" && <p role="status">Loading conversations…</p>}
      {list.status === "error" && (
        <div role="alert">
          <p>{list.error}</p>
          <Button
            onClick={() => {
              session.channels.refreshList?.();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {placement.status !== "ready" && (
        <p role="status">
          {placement.error ?? "Loading Me placement…"}{" "}
          <Button onClick={() => void session.mePlacement.refresh()}>
            Retry Me
          </Button>
        </p>
      )}
      {!conversations.length &&
        list.status === "ready" &&
        placement.status === "ready" && (
          <p className={styles.listMessage}>
            Start a conversation with your agents.
          </p>
        )}
    </nav>
  );
}
