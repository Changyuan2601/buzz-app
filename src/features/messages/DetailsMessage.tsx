import { type ReactNode, useRef, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { ArrowsOutIcon } from "../../shared/design-system/icons";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { FileTypeIcon } from "./FileTypeIcon";
import fileIconStyles from "./FileTypeIcon.module.css";
import styles from "./Messages.module.css";

/** Words a minute, for the reading time a details card states. */
const READING_PACE = 200;

/** A details message reads in its own viewer: the chat shows only its title
 * and that it opens, and the dialog shows the rest at a reading measure. */
export function DetailsMessage({
  title,
  body,
  author,
  createdAt,
  children,
}: {
  title: string | undefined;
  /** The Markdown source of `children`, for its reading time. */
  body: string;
  author: string;
  createdAt: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name =
    title ||
    body
      .trim()
      .split("\n", 1)[0]
      ?.replace(/^[#>*\-+\s]+/, "")
      .trim() ||
    "Details";
  const words = body.match(/\S+/g)?.length ?? 0;
  const minutes = Math.max(1, Math.round(words / READING_PACE));
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${styles.fileAttachment} ${styles.detailsCard}`}
        aria-haspopup="dialog"
        aria-label={`Open details: ${name}`}
        onClick={() => setOpen(true)}
      >
        <span className={fileIconStyles.slot}>
          <FileTypeIcon />
        </span>
        <span className={styles.fileAttachmentBody}>
          <span className={styles.detailsCardTitle}>{name}</span>
          <span className={styles.fileAttachmentMeta}>
            Details · {minutes} min read
          </span>
        </span>
        <ArrowsOutIcon size={20} aria-hidden="true" />
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={name}
        description={`${author} · ${formatItemTimestamp(createdAt, { withTime: true })}`}
        closeLabel="Close details"
        finalFocus={trigger}
      >
        <div className={styles.detailsReader}>{children}</div>
      </Dialog>
    </>
  );
}
