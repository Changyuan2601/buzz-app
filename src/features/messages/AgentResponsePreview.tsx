import type { ReactNode } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { RobotIcon } from "../../shared/design-system/icons";
import styles from "./Messages.module.css";

/** Incoming message geometry for work that has not published a response yet. */
export function AgentResponsePreview({
  name,
  picture,
  layout = "timeline",
  children,
  stackPrevious = false,
}: {
  stackPrevious?: boolean;
  name: string;
  picture?: string | undefined;
  layout?: "timeline" | "thread" | "continuation" | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={styles.message}
      data-stack-previous={stackPrevious || undefined}
      data-layout={layout}
      data-agent-response-preview=""
    >
      <span className={styles.messageGutter} />
      <div className={styles.messageBody}>
        <div className={styles.messageContent}>
          <div className={styles.messageAvatar} title={name}>
            <Avatar
              src={picture}
              alt={name}
              fallback={name}
              shape="squircle"
              size={layout === "timeline" ? "large" : "default"}
            />
          </div>
          {!stackPrevious && (
            <div className={styles.messageHeader}>
              <div className={styles.byline}>
                <strong className={styles.author}>
                  <RobotIcon
                    aria-hidden="true"
                    className={styles.authorAgentIcon}
                  />
                  {name}
                </strong>
              </div>
            </div>
          )}
          <div className={styles.messageBubble}>{children}</div>
        </div>
      </div>
    </div>
  );
}
