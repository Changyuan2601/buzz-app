import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { channelIcon } from "../channels/channel-icon";
import type { ReactNode } from "react";
import type { ChannelSummary } from "../relay/contracts";
import styles from "./Solo.module.css";

export function SoloDraftView({
  children,
  actions,
  fill = false,
}: {
  actions?: ReactNode;
  children: ReactNode;
  /** Content fills the frame above the composer, so it can center itself. */
  fill?: boolean;
}) {
  return (
    <section
      className={styles.work}
      data-attachment-drop-zone=""
      aria-label="New chat"
    >
      <SoloTitle channel={{ name: "New chat" }}>{actions}</SoloTitle>
      <div className={styles.start}>
        <div
          className={
            fill ? `${styles.startContent} ${styles.fill}` : styles.startContent
          }
        >
          {children}
        </div>
      </div>
    </section>
  );
}

/** Keep chat messages and their composer in the same column as a new draft. */
export function SoloColumn({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return enabled ? (
    <div data-solo-column="" className={styles.column}>
      {children}
    </div>
  ) : (
    children
  );
}

export function SoloTitle({
  channel,
  children,
  actions,
}: {
  /** Management actions remain available when the conversation is archived. */
  actions?: ReactNode;
  channel: Pick<ChannelSummary, "name" | "archived" | "private">;
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
