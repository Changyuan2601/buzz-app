import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { channelIcon } from "../channels/channel-icon";
import type { ReactNode } from "react";
import type { ChannelSummary } from "../relay/contracts";
import styles from "./Sessions.module.css";

export function NewSessionView({
  children,
  parentName,
  actions,
  personal = false,
}: {
  actions?: ReactNode;
  personal?: boolean;
  children: ReactNode;
  parentName?: string | undefined;
}) {
  return (
    <section
      className={styles.work}
      aria-label={
        parentName
          ? `New session in ${parentName}`
          : personal
            ? "New chat"
            : "New session"
      }
    >
      <SessionHeading channel={{ name: personal ? "New chat" : "New session" }}>
        {actions}
      </SessionHeading>
      <div className={styles.start} data-personal={personal || undefined}>
        <div
          className={`${styles.startContent} ${personal ? styles.personalStart : ""}`}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

/** Keep session messages and their composer in the same column as a new draft. */
export function SessionColumn({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return enabled ? (
    <div data-session-column="" className={styles.column}>
      {children}
    </div>
  ) : (
    children
  );
}

export function SessionHeading({
  channel,
  children,
  actions,
}: {
  /** Management actions remain available when the conversation is archived. */
  actions?: ReactNode;
  channel: Pick<ChannelSummary, "name" | "archived" | "private">;
  parentName?: string | undefined;
  children?: ReactNode;
}) {
  const Icon = channelIcon(channel);
  const status = channel.archived ? <span>Archived</span> : children;
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel title={channel.name} icon={<Icon size="1rem" />} />
      }
      actions={
        actions ? (
          <>
            {status}
            {actions}
          </>
        ) : (
          status
        )
      }
    />
  );
}
