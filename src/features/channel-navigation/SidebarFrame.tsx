import type { ReactNode } from "react";
import { Panel } from "../../shared/design-system/ui/Panel";
import styles from "../../bundled/channels/Channels.module.css";

/** The mark at the top of a primary sidebar. Me pays homage to Berd. */
export function SidebarBrand({ mark = "buzz" }: { mark?: "buzz" | "berd" }) {
  return (
    <div className={styles.sidebarBrand}>
      <span
        className={styles.sidebarBrandMark}
        data-mark={mark}
        role="img"
        aria-label={mark === "berd" ? "Berd" : "Buzz"}
      />
    </div>
  );
}

/** Shared sidebar surface; callers own its contents, data and scroll behavior. */
export function SidebarFrame({
  label,
  busy,
  launchPending,
  children,
}: {
  label: string;
  busy?: boolean | undefined;
  launchPending?: "required" | "settling" | undefined;
  children?: ReactNode;
}) {
  return (
    <Panel
      as="aside"
      aria-label={label}
      aria-busy={busy}
      data-buzz-launch-pending={launchPending}
    >
      <div className={styles.sidebar}>{children}</div>
    </Panel>
  );
}
