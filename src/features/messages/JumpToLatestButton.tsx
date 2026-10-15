import { ArrowDownIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { useActivityLaneShown, type ActivityLane } from "./activity-lane";
import styles from "./Messages.module.css";

export type { ActivityLane } from "./activity-lane";

export function JumpToLatestButton({
  visible,
  newMessageCount,
  onClick,
  activityLane,
}: {
  visible: boolean;
  newMessageCount: number;
  onClick(): void;
  activityLane?: ActivityLane | undefined;
}) {
  // One element whether or not a lane applies, so a gate flip keeps focus.
  const lane = useActivityLaneShown(activityLane);
  const label =
    newMessageCount > 0
      ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
      : "Jump to latest";
  return (
    <div
      className={styles.jumpToLatest}
      inert={!visible}
      aria-hidden={!visible}
      data-visible={visible}
      data-activity-lane={lane || undefined}
    >
      <div className={styles.jumpToLatestSurface}>
        <Button
          data-jump-to-latest=""
          size="xs"
          shape="capsule"
          variant="ghost"
          onClick={onClick}
        >
          <ArrowDownIcon size={16} aria-hidden="true" />
          {label}
        </Button>
      </div>
    </div>
  );
}
