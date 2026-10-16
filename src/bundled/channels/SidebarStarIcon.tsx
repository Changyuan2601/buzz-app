import { StarFilledIcon } from "../../shared/design-system/icons";
import styles from "./SidebarGroupIcon.module.css";

export function SidebarStarIcon() {
  return (
    <span className={styles.icon} aria-hidden="true" data-sidebar-group-icon="">
      <StarFilledIcon />
    </span>
  );
}
