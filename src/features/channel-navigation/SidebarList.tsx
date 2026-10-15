import type { ReactNode, RefObject } from "react";
import styles from "../../bundled/channels/Channels.module.css";

type Props = {
  children: ReactNode;
  navigation?: {
    label: string;
    ref?: RefObject<HTMLElement | null>;
  };
  contentRef?: RefObject<HTMLDivElement | null>;
  overlay?: ReactNode;
};

export function SidebarList({
  children,
  navigation,
  contentRef,
  overlay,
}: Props) {
  const content = (
    <div ref={contentRef} className={styles.channelListContent}>
      {children}
    </div>
  );
  return (
    <div className={styles.channelListFrame}>
      {navigation ? (
        <nav
          ref={navigation.ref}
          className={styles.channelList}
          aria-label={navigation.label}
        >
          {content}
        </nav>
      ) : (
        <div className={styles.channelList}>{content}</div>
      )}
      {overlay}
    </div>
  );
}
