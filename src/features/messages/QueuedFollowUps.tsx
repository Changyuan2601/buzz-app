import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { TrashIcon } from "../../shared/design-system/icons";
import { followUpQueue } from "./follow-up-queue";
import styles from "./QueuedFollowUps.module.css";

export function QueuedFollowUps({
  session,
  channelId,
  disabled,
  focusComposer,
}: {
  session: RelaySession;
  channelId: string;
  disabled: boolean;
  focusComposer(): void;
}) {
  const queue = followUpQueue(session);
  const entries = useSyncExternalStore(queue.subscribe, queue.snapshot).filter(
    (entry) => entry.channelId === channelId,
  );
  const section = useRef<HTMLElement>(null);
  const focused = useRef<{ id: string; action: "send" | "remove" } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    if (
      !focused.current ||
      entries.some((entry) => entry.id === focused.current?.id)
    )
      return;
    const { action } = focused.current;
    focused.current = undefined;
    // Removal may unmount the entire section. Do not steal focus moved elsewhere
    // while asynchronous send validation was pending.
    if (document.activeElement !== document.body) return;
    const next = section.current?.querySelector<HTMLButtonElement>(
      `button[data-queue-action="${action}"]:not(:disabled)`,
    );
    if (next) next.focus();
    else focusComposer();
  }, [entries, focusComposer]);
  if (!entries.length) return null;
  return (
    <section
      ref={section}
      className={styles.queue}
      aria-label="Queued follow-ups"
    >
      <ol className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id} className={styles.row}>
            <div className={styles.content}>
              <p className={`text-caption ${styles.preview}`}>
                {entry.text || "Attachment"}
              </p>
              {entry.error && (
                <p role="alert" className="text-body-sm text-danger">
                  {entry.error}
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <IconButton
                data-queue-action="remove"
                onFocus={() => {
                  focused.current = { id: entry.id, action: "remove" };
                }}
                data-remove-action
                variant="destructive-quiet"
                shape="inset"
                size="sm"
                aria-label="Remove queued message"
                icon={<TrashIcon size={16} strokeWidth={1.5} />}
                onClick={() => queue.remove(entry.id)}
              />
              <Button
                data-queue-action="send"
                onFocus={() => {
                  focused.current = { id: entry.id, action: "send" };
                }}
                variant="subtle-muted"
                size="caption"
                disabled={disabled}
                onClick={() => queue.sendNow(entry.id)}
              >
                Send
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
