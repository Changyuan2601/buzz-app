import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { composerFor, DetailsSheet } from "./DetailsSheet";
import styles from "./Messages.module.css";

/** A details message reads like any other in the chat, clipped to its first
 * lines, and opens whole in a reader that grows out of the composer. */
export function DetailsMessage({
  title,
  author,
  createdAt,
  preview,
  children,
}: {
  title: string | undefined;
  author: string;
  createdAt: number;
  /** The whole message as the chat renders it, clipped to its first lines. */
  preview: ReactNode;
  /** The reader's body, below its title. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [composer, setComposer] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = clip.current;
    if (!element) return;
    const measure = () =>
      setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, []);
  // Details open with their brief rather than a title, so the reader is
  // headed by who wrote them; an older details message keeps its heading.
  const name = title || author;
  const show = () => {
    setComposer(composerFor(clip.current));
    setOpen(true);
  };
  const time = formatItemTimestamp(createdAt, { withTime: true });
  const description = title ? `${author} · ${time}` : time;
  return (
    <div className={styles.detailsPreview} data-clipped={clipped || undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Show more is the keyboard path; this only widens the pointer target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Show more is the keyboard path; this only widens the pointer target. */}
      <div
        ref={clip}
        className={styles.detailsClip}
        onClick={(event) => {
          // Links, mentions and selected text keep their own meaning.
          if (
            !clipped ||
            (event.target instanceof Element &&
              event.target.closest("a, button, [role=button]")) ||
            !getSelection()?.isCollapsed
          )
            return;
          show();
        }}
      >
        {preview}
      </div>
      {clipped && (
        <span className={styles.detailsMore}>
          <Button
            ref={trigger}
            variant="link"
            size="inline"
            aria-haspopup="dialog"
            aria-label={title && `Show more: ${title}`}
            onClick={show}
          >
            Show more
          </Button>
        </span>
      )}
      {composer ? (
        <DetailsSheet
          open={open}
          onOpenChange={setOpen}
          composer={composer}
          title={name}
          description={description}
          closeLabel="Close details"
          finalFocus={trigger}
        >
          <div className={styles.detailsReader}>{children}</div>
        </DetailsSheet>
      ) : (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title={name}
          description={description}
          closeLabel="Close details"
          finalFocus={trigger}
        >
          <div className={styles.detailsReader}>{children}</div>
        </Dialog>
      )}
    </div>
  );
}
