import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./SidebarActivityAge.module.css";
import { useSidebarActivityNow } from "./useSidebarActivityClock";

export function isSidebarActivityTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(new Date(value * 1000).getTime())
  );
}

export function SidebarActivityAge({ timestamp }: { timestamp: number }) {
  const now = useSidebarActivityNow();
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return (
    <time
      className={`text-caption ${styles.age}`}
      dateTime={date.toISOString()}
    >
      <span aria-hidden="true">
        {relativeTimestamp(timestamp, now, "compact")}
      </span>
    </time>
  );
}

export function SidebarActivityAgeDescription({
  id,
  timestamp,
}: {
  id: string;
  timestamp: number;
}) {
  const now = useSidebarActivityNow();
  return (
    <span className="sr-only" id={id}>
      Last activity: {relativeTimestamp(timestamp, now)}.
    </span>
  );
}
