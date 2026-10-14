import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { prepareReviewEntrance } from "./use-review-entrance";
import { useMediaCorners } from "./use-media-corners";
import { MediaViewer } from "./MediaAttachment";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../relay/contracts";
import { validatedBlurhash } from "../relay/blurhash";
import { BLURHASH_SIZE, paintBlurhash } from "./blurhash";
import styles from "./Messages.module.css";

export function AttachmentImage({
  attachment,
  source,
  cached = false,
  onOpenReview,
  keepMounted,
  label = "Open image attachment",
}: {
  label?: string;
  attachment: Attachment;
  source: string | undefined;
  cached?: boolean;
  onOpenReview?: (attachment: Attachment, seconds: number) => void;
  /** Pins the owning row in a virtualized list; returns the release. */
  keepMounted?: (() => () => void) | undefined;
}) {
  const active = useConversationPresentation();
  const corners = useMediaCorners();
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!active && viewerOpen) setViewerOpen(false);
  // The viewer portal and its opener live in this row; eviction closes it.
  useEffect(() => {
    const release = viewerOpen ? keepMounted?.() : undefined;
    // The modal boundary restores focus on the next frame; releasing after it
    // lets the restored preview keep the row mounted instead.
    return release && (() => void requestAnimationFrame(release));
  }, [viewerOpen, keepMounted]);
  const [decoded, setDecoded] = useState<{
    source: string | undefined;
    dimensions?: NonNullable<Attachment["dimensions"]>;
  }>({ source });
  if (decoded.source !== source) setDecoded({ source });
  const onDecoded = useCallback(
    (dimensions: NonNullable<Attachment["dimensions"]>) => {
      if (source) setDecoded({ source, dimensions });
    },
    [source],
  );
  const decodedDimensions =
    decoded.source === source ? decoded.dimensions : undefined;
  const dimensions = decodedDimensions ?? attachment.dimensions;
  const width = dimensions
    ? Math.min(
        360,
        dimensions.width,
        (320 * dimensions.width) / dimensions.height,
      )
    : 0;
  const height = dimensions
    ? (width * dimensions.height) / dimensions.width
    : 0;
  const previewWidth = decodedDimensions ? Math.max(1, width) : width;
  const previewHeight = decodedDimensions ? Math.max(1, height) : height;
  const style =
    dimensions &&
    Number.isFinite(previewWidth) &&
    Number.isFinite(previewHeight) &&
    previewWidth >= 1 &&
    previewHeight >= 1
      ? {
          width: previewWidth,
          aspectRatio: decodedDimensions
            ? `${previewWidth} / ${previewHeight}`
            : `${dimensions.width} / ${dimensions.height}`,
        }
      : undefined;
  if (!source)
    return cached ? (
      <span
        ref={corners}
        className={`${styles.attachmentImage} ${styles.mediaPlaceholder}`}
        style={style}
        aria-hidden="true"
      />
    ) : (
      <span
        ref={corners}
        className={`${styles.attachmentImage} ${styles.mediaPlaceholder} ${styles.attachmentImageUnavailable}`}
        style={style}
        role="status"
      >
        Image unavailable
      </span>
    );
  return (
    <>
      <a
        ref={corners}
        className={styles.attachmentImage}
        style={style}
        href={source}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        data-media-preview=""
        data-image-ready={decodedDimensions ? true : undefined}
        onClick={(event) => {
          // Every activation stays in-app, modifiers included: the desktop
          // opener treats an unprevented Ctrl/Shift or `_blank` click as browser
          // intent, and no browser tab holds the app's credentials.
          event.preventDefault();
          prepareReviewEntrance(event);
          if (onOpenReview) onOpenReview(attachment, 0);
          else setViewerOpen(true);
        }}
      >
        {/* Retargeting retires both the DOM pixels and all pending callbacks before
            the new source can paint. Session switches also remount the workspace. */}
        <span className={styles.attachmentImagePixels}>
          <ImagePixels
            key={JSON.stringify([source, attachment.blurhash])}
            source={source}
            blurhash={attachment.blurhash}
            onDecoded={onDecoded}
          />
        </span>
        <svg
          className={styles.imageOutline}
          data-image-outline=""
          aria-hidden="true"
        >
          <path />
        </svg>
      </a>
      {active &&
        viewerOpen &&
        createPortal(
          <MediaViewer
            title="Image attachment"
            close={() => setViewerOpen(false)}
          >
            <img
              className={styles.mediaViewerImage}
              src={source}
              alt="Attachment preview"
            />
          </MediaViewer>,
          document.body,
        )}
    </>
  );
}

function ImagePixels({
  source,
  blurhash,
  onDecoded,
}: {
  source: string;
  blurhash: string | undefined;
  onDecoded: (dimensions: NonNullable<Attachment["dimensions"]>) => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const hash = validatedBlurhash(blurhash);
  useEffect(() => {
    const original = image.current;
    if (!original) return;
    let active = true;
    let decoded = false;
    let painted = false;
    let decoding = false;
    let observer: IntersectionObserver | undefined;
    const loaded = async () => {
      if (!active || decoding || decoded || !original.naturalWidth) return;
      decoding = true;
      try {
        await original.decode();
        if (!active) return;
        decoded = true;
        observer?.disconnect();
        setReady(true);
        if (original.naturalWidth > 0 && original.naturalHeight > 0)
          onDecoded({
            width: original.naturalWidth,
            height: original.naturalHeight,
          });
      } catch {
        // Keep the blur preview on original failure, including decode rejection.
      } finally {
        decoding = false;
      }
    };
    original.addEventListener("load", loaded);
    if (original.complete) void loaded();
    const preview = canvas.current;
    if (hash && preview && typeof IntersectionObserver !== "undefined") {
      // Original requests keep native loading="lazy". Only preview CPU work is
      // visibility-gated, including nonvirtualized thread rows. No new scheduler.
      observer = new IntersectionObserver((entries) => {
        if (
          !active ||
          decoded ||
          painted ||
          !entries.some((entry) => entry.isIntersecting)
        )
          return;
        observer?.disconnect();
        painted = true;
        paintBlurhash(preview, hash);
      });
      observer.observe(preview);
    }
    // Without IntersectionObserver, retain the old placeholder rather than
    // eagerly decode every mounted thread attachment.
    return () => {
      active = false;
      original.removeEventListener("load", loaded);
      observer?.disconnect();
    };
  }, [hash, onDecoded]);
  return (
    <>
      {hash && !ready && (
        <canvas
          ref={canvas}
          width={BLURHASH_SIZE}
          height={BLURHASH_SIZE}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}
      <img
        ref={image}
        src={source}
        alt=""
        loading="lazy"
        style={{ visibility: ready ? "visible" : "hidden" }}
      />
    </>
  );
}
