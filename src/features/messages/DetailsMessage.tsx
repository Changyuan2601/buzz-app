import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { DetailsSheet } from "./DetailsSheet";
import { overlayHostFor, type ComposerOverlayHost } from "./composer-overlay";
import styles from "./Messages.module.css";

const HEADING = /^H[1-6]$/;

/** The blocks the chat shows: the opening brief, after a leading heading when
 * an older details message has one. */
const shownBlocks = (blocks: Element[]) =>
  blocks[0] && HEADING.test(blocks[0].tagName) ? 2 : 1;

/** Whether the chat holds back any of the message: a later block, or a brief
 * longer than its lines. */
function holdsBack(clip: HTMLElement) {
  const text = clip.firstElementChild;
  if (!text) return false;
  const blocks = [...text.children];
  const shown = shownBlocks(blocks);
  return (
    blocks.length > shown ||
    blocks
      .slice(0, shown)
      .some((block) => block.scrollHeight > block.clientHeight + 1)
  );
}

/** A details message reads in the chat as its opening brief, in full, and
 * opens whole in a reader that grows out of the composer. */
export function DetailsMessage({
  author,
  avatar,
  createdAt,
  preview,
  children,
  keepMounted,
}: {
  author: string;
  /** The author's avatar, beside their name in the reader. */
  avatar: ReactNode;
  createdAt: number;
  /** The whole message as the chat renders it; only its brief shows. */
  preview: ReactNode;
  /** The reader's body. */
  children: ReactNode;
  keepMounted?: (() => () => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [retained, setRetained] = useState(false);
  useEffect(() => {
    if (retained) return keepMounted?.();
  }, [retained, keepMounted]);
  const [host, setHost] = useState<ComposerOverlayHost | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = clip.current;
    if (!element) return;
    const measure = () => setClipped(holdsBack(element));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const show = () => {
    setRetained(true);
    setHost(overlayHostFor(clip.current));
    setOpen(true);
  };
  const time = formatItemTimestamp(createdAt, { withTime: true });
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
            onClick={show}
          >
            Show more
          </Button>
        </span>
      )}
      {host ? (
        <DetailsSheet
          open={open}
          onOpenChange={setOpen}
          onClosed={() => setRetained(false)}
          host={host}
          leading={avatar}
          title={author}
          description={time}
          closeLabel="Close details"
          finalFocus={trigger}
        >
          <div className={styles.detailsReader}>{children}</div>
        </DetailsSheet>
      ) : (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          onOpenChangeComplete={(next) => {
            if (!next) setRetained(false);
          }}
          title={author}
          description={time}
          closeLabel="Close details"
          finalFocus={trigger}
        >
          <div className={styles.detailsReader}>{children}</div>
        </Dialog>
      )}
    </div>
  );
}
