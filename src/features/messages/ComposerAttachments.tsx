import type {
  AttachmentRenderer,
  ContributionReader,
} from "../conversation/contracts";
import { AttachmentView } from "../conversation/AttachmentView";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  ArrowsClockwiseIcon,
  CircleNotchIcon,
  FileTextIcon,
  WarningCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import type { DraftAttachment } from "./attachment-draft";
import styles from "./ComposerAttachments.module.css";
import { useAttachmentPoof } from "./AttachmentPoof";
import { useMediaElementSource } from "./use-media-element-source";

export function ComposerAttachments({
  items,
  renderers,
  disabled,
  remove,
  retry,
  media,
}: {
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  media(url: string): string | undefined;
  items: readonly DraftAttachment[];
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
}) {
  const poof = useAttachmentPoof(items.length > 0);
  return (
    <>
      {poof.overlay}
      {items.length > 0 && (
        <section aria-label="Attachments" className={styles.attachments}>
          <ul className={styles.list}>
            {items.map((item) => (
              <AttachmentItem
                renderers={renderers}
                media={media}
                key={item.id}
                item={item}
                disabled={disabled}
                remove={(id, origin) => {
                  remove(id);
                  poof.emit(origin);
                }}
                retry={retry}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
function AttachmentItem({
  item,
  renderers,
  disabled,
  remove,
  retry,
  media,
}: {
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  media(url: string): string | undefined;
  item: DraftAttachment;
  disabled: boolean;
  remove(id: string, origin: DOMRect): void;
  retry(id: string): void;
}) {
  const active = useConversationPresentation();
  const presented = useRef(active);
  presented.current = active;
  const [source, setSource] = useState<string>();
  const [previewFailed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (!active && open) setOpen(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const type = item.uploaded?.type || item.file.type || "";
  const uploadedSource = item.uploaded ? media(item.uploaded.url) : undefined;
  // Once uploaded, the relay's canonical type wins over the original name/type.
  const image =
    /^image\/(png|jpeg|gif|webp)$/.test(type) ||
    (!item.uploaded && /\.(png|jpe?g|gif|webp)$/i.test(item.file.name));
  const video =
    type.startsWith("video/") ||
    (!item.uploaded && /\.(mp4|mov|webm|m4v)$/i.test(item.file.name));
  const element = useMediaElementSource(video ? source : undefined);
  const videoSource = element.src;
  const failed = previewFailed || element.unavailable;
  useEffect(() => {
    setFailed(false);
    if (!image && !video && !item.voice) {
      setSource(undefined);
      return;
    }
    if (item.uploaded) {
      setSource(uploadedSource);
      return;
    }
    const url = URL.createObjectURL(item.file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, item.uploaded, item.voice, image, video, uploadedSource]);
  const bytes = item.uploaded?.size ?? item.file.size;
  const size =
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const status = {
    queued: "Queued",
    preparing: "Preparing…",
    uploading: "Uploading…",
    ready: "Ready",
    error: "Upload failed",
  }[item.status];
  // Queued files wait for Send; only preparation and transfer are busy.
  const busy = item.status === "preparing" || item.status === "uploading";
  if (item.voice && source && renderers)
    return (
      <li className={styles.voiceItem} data-voice-draft>
        <AttachmentView
          registry={renderers}
          attachment={{
            url: item.uploaded?.url ?? source,
            kind: "audio",
            mime: item.uploaded?.type ?? item.file.type,
            name: item.uploaded?.name ?? item.file.name,
            voiceNote: true,
            ...item.voice,
          }}
          source={source}
          onRemove={
            disabled
              ? undefined
              : () =>
                  remove(
                    item.id,
                    trigger.current?.getBoundingClientRect() ?? new DOMRect(),
                  )
          }
          fallback={
            <div>
              <span>{item.file.name}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(item.id, new DOMRect())}
              >
                Remove voice note
              </button>
            </div>
          }
        />
        {item.error && (
          <>
            <span role="alert">{item.error}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => retry(item.id)}
            >
              Retry voice note upload
            </button>
          </>
        )}
      </li>
    );
  return (
    <li
      className={styles.item}
      data-media={source && !failed && item.status !== "error" ? "" : undefined}
    >
      {source && !failed ? (
        <Tooltip content={`${item.file.name} · ${size} · ${status}`}>
          <button
            ref={trigger}
            className={styles.preview}
            type="button"
            aria-label={`Preview ${item.file.name}`}
            onClick={() => setOpen(true)}
          >
            {image ? (
              <img
                key={source}
                src={source}
                alt=""
                onError={() => setFailed(true)}
              />
            ) : (
              <video
                key={source}
                src={videoSource}
                muted
                playsInline
                preload="metadata"
                onError={() => setFailed(true)}
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = Math.min(
                    0.1,
                    event.currentTarget.duration || 0.1,
                  );
                }}
              />
            )}
          </button>
        </Tooltip>
      ) : (
        <span className={styles.fileIcon}>
          <FileTextIcon size={24} />
        </span>
      )}
      <div className={styles.details}>
        <Tooltip content={`${item.file.name} · ${size} · ${type || "File"}`}>
          <span className={styles.name} tabIndex={source && !failed ? -1 : 0}>
            {item.file.name}
          </span>
        </Tooltip>
        <span
          className={styles.hint}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="sr-only">{item.file.name}: </span>
          {size} · {status}
        </span>
        {failed && <span className="sr-only">Preview unavailable</span>}
      </div>
      <div className={styles.actions}>
        {(item.error || failed) && (
          <span className={styles.error}>
            <IconButton
              size="xs"
              aria-label={`Attachment issue: ${item.file.name}`}
              title={item.error || "Preview unavailable"}
              icon={<WarningCircleIcon size={16} />}
            />
            {item.error && (
              <span role="alert" className="sr-only">
                {item.error}
              </span>
            )}
          </span>
        )}
        {item.status === "error" && (
          <IconButton
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label={`Retry ${item.file.name}`}
            title="Retry upload"
            onClick={() => retry(item.id)}
            icon={<ArrowsClockwiseIcon size={16} />}
          />
        )}
        <IconButton
          size="xs"
          variant="primary"
          type="button"
          disabled={disabled}
          aria-label={`Remove ${item.file.name}`}
          title="Remove attachment"
          onClick={(event) =>
            remove(item.id, event.currentTarget.getBoundingClientRect())
          }
          data-uploading={busy || undefined}
          icon={
            <span className={styles.removeIcon}>
              {busy && <CircleNotchIcon className={styles.spinner} size={16} />}
              <XIcon className={styles.removeX} size={16} />
            </span>
          }
        />
      </div>
      {active && (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title={item.file.name}
          finalFocus={() => (presented.current ? trigger.current : false)}
        >
          {open &&
            source &&
            (image ? (
              <img
                className={styles.fullPreview}
                src={source}
                alt={item.file.name}
              />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: user-selected video has no caption track.
              <video
                className={styles.fullPreview}
                src={videoSource}
                controls
                playsInline
              />
            ))}
        </Dialog>
      )}
    </li>
  );
}
