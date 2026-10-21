import { FadingLabel } from "./FadingLabel";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons/index";
import { useId, type ReactElement, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import styles from "./ChannelSidebarRow.module.css";

export function ChannelSidebarRow({
  channel,
  largeArtwork = false,
  icon,
  nameAccessory,
  badge,
  working = false,
  ordinary = false,
  dmVisualSpacing = false,
  wrapSelect,
  selected,
  presenceDescription,
  onSelect,
  onPrepare,
  onRename,
  onHideDm,
}: {
  channel: ChannelSummary;
  largeArtwork?: boolean;
  icon: ReactNode;
  nameAccessory?: ReactNode;
  badge?: ReactNode;
  /** Agents are working here; the badge reserves its own trailing space. */
  working?: boolean;
  /** Ordinary unread backlog emphasises the label. */
  ordinary?: boolean;
  dmVisualSpacing?: boolean;
  wrapSelect?: ((trigger: ReactElement) => ReactNode) | undefined;
  selected?: string | undefined;
  presenceDescription?: string | undefined;
  onSelect: (id: string) => void;
  onPrepare: (id: string) => void;
  onRename?: (() => void) | undefined;
  onHideDm?: (id: string) => void;
}) {
  const presenceId = useId();
  const selectButton = (
    <NavigationItem
      type="button"
      variant={largeArtwork ? "rail" : "row"}
      aria-label={largeArtwork ? channel.name : undefined}
      data-channel-id={channel.id}
      data-working={working || undefined}
      aria-current={selected === channel.id ? "page" : undefined}
      aria-describedby={presenceDescription ? presenceId : undefined}
      onPointerEnter={() => onPrepare(channel.id)}
      onFocus={() => onPrepare(channel.id)}
      onClick={(event) => {
        if (event.detail < 2) onSelect(channel.id);
      }}
      onDoubleClick={onRename}
      selected={selected === channel.id}
      label={
        <span
          className={styles.nameContent}
          data-name-accessory={nameAccessory ? "" : undefined}
        >
          <FadingLabel className={styles.label}>{channel.name}</FadingLabel>
          {nameAccessory}
        </span>
      }
      icon={
        <span
          className={styles.iconSpace}
          data-large-artwork={largeArtwork || undefined}
          data-dm-visual={(!largeArtwork && dmVisualSpacing) || undefined}
        >
          {icon}
        </span>
      }
      trailing={
        badge && (
          <span className={styles.badges} data-working={working || undefined}>
            {badge}
          </span>
        )
      }
    />
  );
  return (
    <div
      className={largeArtwork ? styles.railRow : styles.row}
      data-channel-sidebar-row=""
      data-ordinary={ordinary || undefined}
      data-selected={selected === channel.id || undefined}
    >
      <div className={styles.select}>
        {wrapSelect ? wrapSelect(selectButton) : selectButton}
        {presenceDescription && (
          <span className="sr-only" id={presenceId}>
            {presenceDescription}
          </span>
        )}
      </div>
      {!largeArtwork && channel.channelType === "dm" && onHideDm && (
        <span className={`${styles.more} ${styles.remove}`}>
          <IconButton
            type="button"
            size="compact"
            aria-label={`Remove ${channel.name} from DMs`}
            onClick={(event) => {
              const section = event.currentTarget.closest(
                "[data-sidebar-section]",
              );
              const rows = [
                ...(section?.querySelectorAll<HTMLElement>(
                  "button[data-channel-id]",
                ) ?? []),
              ];
              const index = rows.findIndex(
                (row) => row.dataset.channelId === channel.id,
              );
              const otherSection = [
                ...(section?.parentElement?.querySelectorAll<HTMLElement>(
                  "details > summary",
                ) ?? []),
              ].find((summary) => summary.parentElement !== section);
              (rows[index + 1] ?? rows[index - 1] ?? otherSection)?.focus();
              onHideDm(channel.id);
            }}
            icon={<XIcon size={15} aria-hidden="true" />}
          />
        </span>
      )}
    </div>
  );
}
