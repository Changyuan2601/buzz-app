import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import type { ActivityPresentation } from "./activity-presentation";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { CaretUpIcon } from "../../shared/design-system/icons";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { toggleActivityHistory } from "./activity-avatar-motion";
import type { Profile } from "../relay/contracts";
import { AgentAvatar } from "../agents/AgentAvatar";
import { avatarMedia } from "../../shared/avatar-source";
import { messagePreviewText } from "../conversation/message-preview-text";
import styles from "./Messages.module.css";

/** One stable disclosure for a run of activity, showing its latest speaker. */
export function ActivityGroupPreview({
  group,
  profiles,
  media,
  expanded,
  onToggle,
  layout = "timeline",
}: {
  group: ActivityPresentation;
  profiles: ReadonlyMap<string, Profile>;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  layout?: "timeline" | "thread";
}) {
  const { latest: row, history, participants, done, working } = group;
  const profile = profiles.get(row.authorId);
  const motionKey = (author: string) => `${history[0]?.id ?? row.id}:${author}`;
  const name = profile?.name ?? row.authorId.slice(0, 10);
  const text = Array.from(messagePreviewText(row.content).replace(/\s+/g, " "));
  const preview = done
    ? `${history.length} completed ${history.length === 1 ? "step" : "steps"}`
    : text.length > 280
      ? `${text.slice(0, 279).join("")}…`
      : text.join("");
  return (
    <div
      className={styles.audienceRow}
      data-layout={layout}
      data-collapse={expanded || undefined}
    >
      <div className={styles.audienceEntry}>
        <button
          type="button"
          data-buzz-ui=""
          className={styles.audienceLine}
          data-collapse={expanded || undefined}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Show"} activity history: ${name}: ${preview}`}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            toggleActivityHistory(
              event.currentTarget,
              onToggle,
              event.detail === 0,
              history[0]?.id ?? row.id,
            );
          }}
        >
          {expanded ? (
            <Avatar
              size="small"
              shape="squircle"
              alt=""
              fallback=""
              fallbackContent={
                <CaretUpIcon
                  className={styles.activityCollapseIcon}
                  aria-hidden="true"
                />
              }
            />
          ) : participants.length > 1 ? (
            <AvatarStack
              size="small"
              max={3}
              items={participants.map((id) => ({
                id,
                name: profiles.get(id)?.name ?? id.slice(0, 10),
                src: avatarMedia(profiles.get(id)?.picture, media),
                shape: "squircle",
                motionKey: motionKey(id),
              }))}
            />
          ) : (
            <span
              className={styles.audienceAvatar}
              title={name}
              data-avatar-motion-key={motionKey(row.authorId)}
            >
              <AgentAvatar
                src={avatarMedia(profile?.picture, media)}
                alt=""
                fallback={name}
                size="fill"
                shape="squircle"
              />
            </span>
          )}
          <span className={styles.audiencePreviewText}>
            {expanded ? (
              "Collapse"
            ) : (
              <ShimmerText active={working}>{preview}</ShimmerText>
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
