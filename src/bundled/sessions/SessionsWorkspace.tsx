import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Panel } from "../../shared/design-system/ui/Panel";
import { channelIcon } from "../../features/channels/channel-icon";
import { SessionSections } from "./SessionSections";
import type { RelaySession } from "../../features/relay/session";
import type { ReactNode } from "react";
import styles from "./SessionsWorkspace.module.css";
import channelStyles from "../channels/Channels.module.css";

/** Presentation only. The caller supplies authorized, saved sessions. */
export type SessionListItem = Readonly<{
  id: string;
  title: string;
  parentName?: string;
  parentPrivate?: true;
  content?: ReactNode;
}>;

export function SessionsWorkspace({
  sessions,
  session,
  scope = "",
  selected,
  onSelect,
  onNew,
  listStatus,
  children,
}: {
  sessions: readonly SessionListItem[];
  session?: RelaySession;
  scope?: string;
  selected?: string;
  onSelect: (id: string) => void;
  onNew: (sectionId?: string) => void;
  listStatus?: ReactNode;
  children: ReactNode;
}) {
  const renderSession = (session: SessionListItem) => {
    const ParentChannelIcon = channelIcon({
      private: session.parentPrivate,
    });
    return (
      <NavigationItem
        type="button"
        key={session.id}
        aria-current={session.id === selected ? "page" : undefined}
        selected={session.id === selected}
        onClick={() => onSelect(session.id)}
        label={
          <span className={styles.historyLabel}>
            {session.parentName && (
              <small className={styles.parentChannel}>
                <ParentChannelIcon size={12} aria-hidden="true" />
                <span>{session.parentName}</span>
              </small>
            )}
            <span className={styles.sessionRow}>
              {session.content ?? <span>{session.title}</span>}
            </span>
          </span>
        }
      />
    );
  };

  return (
    <section className={styles.container} aria-label="Sessions">
      <div className={styles.workspace}>
        <Panel as="aside" aria-label="Session history">
          <div className={`${channelStyles.sidebar} ${styles.sidebar}`}>
            <nav className={styles.history} aria-label="Session sections">
              {session ? (
                <SessionSections
                  session={session}
                  scope={scope}
                  sessions={sessions}
                  renderSession={renderSession}
                  onNew={onNew}
                />
              ) : (
                sessions.map(renderSession)
              )}
              {listStatus ??
                (!sessions.length && (
                  <p className={styles.listMessage}>
                    Your conversations will appear here after your first
                    message.
                  </p>
                ))}
            </nav>
          </div>
        </Panel>
        <Panel as="div">
          <div className={styles.content}>{children}</div>
        </Panel>
      </div>
    </section>
  );
}
