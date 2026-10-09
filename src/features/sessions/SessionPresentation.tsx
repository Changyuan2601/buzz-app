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
}: {
  actions?: ReactNode;
  children: ReactNode;
  parentName?: string | undefined;
}) {
  return (
    <section
      className={styles.work}
      aria-label={parentName ? `New session in ${parentName}` : "New session"}
    >
      <SessionHeading channel={{ name: "New session" }}>
        {actions}
      </SessionHeading>
      <div className={styles.start}>
        <div className={styles.startContent}>{children}</div>
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
  return enabled ? <div className={styles.column}>{children}</div> : children;
}

export function SessionHeading({
  channel,
  children,
}: {
  channel: Pick<ChannelSummary, "name" | "archived" | "private">;
  parentName?: string | undefined;
  children?: ReactNode;
}) {
  const Icon = channelIcon(channel);
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel title={channel.name} icon={<Icon size="1rem" />} />
      }
      actions={channel.archived ? <span>Archived</span> : children}
    />
  );
}
