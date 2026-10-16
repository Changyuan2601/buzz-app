import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import { MessageMarkdown } from "./MessageMarkdown";
import { useReferenceDirectory } from "./ReferenceText";
import styles from "./Messages.module.css";

export function ComposerSessionCards({
  cards,
  session,
  scope,
  channelId,
  extensions,
  disabled,
  remove,
}: {
  cards: readonly string[];
  session: RelaySession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  disabled: boolean;
  remove(index: number): void;
}) {
  const directory = useReferenceDirectory(session);
  if (!cards.length) return null;
  return (
    <section
      aria-label="Session attachments"
      className={styles.composerSessionCards}
    >
      {cards.map((content, index) => (
        <div className={styles.composerSessionCard} key={content}>
          <div className={styles.composerSessionCardContent}>
            <MessageMarkdown
              row={{
                id: "composer-session",
                authorId: "",
                createdAt: 0,
                channelId,
                content,
                mentions: [],
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              }}
              directory={directory}
              session={session}
              scope={scope}
              extensions={extensions}
              media={session.media}
              onOpenLink={() => false}
              interactive={false}
            />
          </div>
          <IconButton
            type="button"
            size="xs"
            shape="round"
            disabled={disabled}
            aria-label={`Remove session attachment ${index + 1}`}
            icon={<XIcon size={16} />}
            onClick={() => remove(index)}
          />
        </div>
      ))}
    </section>
  );
}
