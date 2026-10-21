import type { ReactNode } from "react";
import styles from "./ProfileHero.module.css";

/** Decorative artwork; callers resolve images through their existing media owner. */
export function ProfileBackdrop({
  src,
  children,
  kind = "agent",
}: {
  src: string | null | undefined;
  children?: ReactNode;
  kind?: "human" | "agent";
}) {
  if (!src) return null;
  return (
    <div className={styles.avatarBackdrop} aria-hidden="true">
      <div
        className={styles.avatarBackdropImage}
        data-kind={kind}
        style={
          children
            ? undefined
            : { backgroundImage: `url(${JSON.stringify(src)})` }
        }
      >
        {children}
      </div>
    </div>
  );
}
