import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./SidebarActivityAge.module.css";
import { useSidebarActivityNow } from "./useSidebarActivityClock";

export function SidebarActivityAge({ timestamp }: { timestamp: number }) {
  const now = useSidebarActivityNow();
  return (
    <time
      className={`text-caption ${styles.age}`}
      dateTime={new Date(timestamp * 1000).toISOString()}
    >
      <span aria-hidden="true">
        {relativeTimestamp(timestamp, now, "compact")}
      </span>
      <span className="sr-only">{relativeTimestamp(timestamp, now)}</span>
    </time>
  );
}
