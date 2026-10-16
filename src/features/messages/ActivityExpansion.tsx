import { Collapsible } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import styles from "./Messages.module.css";

/** Reveal intrinsic space without rounding each virtual row to whole pixels.
 * Base UI retains exiting content until the grid transition finishes. */
export function ActivityExpansion({
  open,
  enabled = true,
  className,
  children,
}: {
  open: boolean;
  enabled?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  if (!enabled) return open ? children : null;
  return (
    <Collapsible.Root open={open} className={styles.activityExpansionRoot}>
      <Collapsible.Panel
        className={`${styles.activityExpansion} ${className ?? ""}`}
        inert={!open}
        aria-hidden={!open}
      >
        <div className={styles.activityExpansionContent}>{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
