import {
  ArrowUpRightIcon,
  DownloadIcon,
} from "../../shared/design-system/icons/index";
import { FileTypeIcon } from "./FileTypeIcon";
import type { Attachment } from "../relay/contracts";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";
import { downloadNativeMedia } from "./native-download";
import { useState } from "react";
import {
  IconButton,
  type IconButtonProps,
} from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${Math.round(size / (1024 * 1024))} MB`;
  return `${Math.round(size / (1024 * 1024 * 1024))} GB`;
}

function mimeLabel(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const [type, subtype] = mime.split("/");
  if (!type || !subtype) return undefined;
  if (subtype === "pdf") return "PDF file";
  if (!/^[a-z0-9]+$/i.test(subtype)) return undefined;
  return `${subtype.toUpperCase()} file`;
}

export function FileAttachment({
  attachment,
  source,
  onOpenLink,
  onPreview,
  variant = "card",
}: {
  attachment: Attachment;
  source: string | undefined;
  onOpenLink(url: string): boolean;
  onPreview?: (() => void) | undefined;
  variant?: "card" | "summary";
}) {
  const [downloadError, setDownloadError] = useState(false);
  const displayName = attachment.name ?? mimeLabel(attachment.mime) ?? "File";
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const externalSource = !!source && safeOpenUrl(source) && !proxySource;
  const download = () => {
    if (!source) return;
    setDownloadError(false);
    void downloadNativeMedia(source, attachment.name ?? "").catch(() =>
      setDownloadError(true),
    );
  };
  if (source && !proxySource && !externalSource)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );

  if (source && proxySource && (onPreview || variant === "summary")) {
    const type =
      /\.(md|markdown)$/i.test(attachment.name ?? "") ||
      /^text\/(x-)?markdown(?:;|$)/i.test(attachment.mime ?? "")
        ? "Markdown"
        : /\.txt$/i.test(attachment.name ?? "") ||
            attachment.mime?.startsWith("text/plain")
          ? "Plain text"
          : (mimeLabel(attachment.mime) ?? "File");
    const label = (
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName} title={displayName}>
          {displayName}
        </span>
        <span className={styles.fileAttachmentMeta}>
          {type}
          {attachment.size !== undefined &&
            ` · ${formatFileSize(attachment.size)}`}
        </span>
      </span>
    );
    const action = {
      "aria-label": `Download ${displayName}`,
      title: `Download ${displayName}`,
      icon: <DownloadIcon aria-hidden="true" />,
      shape: variant === "summary" ? "control" : "row-end",
    } satisfies IconButtonProps;
    return (
      <>
        <div
          className={
            variant === "summary"
              ? styles.fileSummary
              : styles.filePreviewAttachment
          }
        >
          <div className={styles.filePreviewMain}>
            {onPreview ? (
              <NavigationItem
                aria-label={`Preview ${displayName}`}
                icon={
                  <FileTypeIcon name={attachment.name} mime={attachment.mime} />
                }
                label={label}
                onClick={onPreview}
              />
            ) : (
              label
            )}
          </div>
          <span className={styles.fileDownloadAction}>
            {nativeSource ? (
              <IconButton {...action} onClick={download} />
            ) : (
              <IconButton
                {...action}
                nativeButton={false}
                role="link"
                render={<a href={source} download={attachment.name ?? ""} />}
              />
            )}
          </span>
        </div>
        {downloadError && <span role="alert">Download failed</span>}
      </>
    );
  }

  const content = (
    <>
      <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>
          {source
            ? attachment.size
              ? formatFileSize(attachment.size)
              : proxySource
                ? "Download file"
                : "Open file"
            : "File unavailable"}
        </span>
      </span>
      {proxySource ? (
        <DownloadIcon size={20} aria-hidden="true" />
      ) : (
        <ArrowUpRightIcon size={20} aria-hidden="true" />
      )}
    </>
  );
  if (!source)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );
  if (externalSource)
    return (
      <a
        className={styles.fileAttachment}
        href={source}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${displayName}`}
        title={displayName}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (onOpenLink(source)) event.preventDefault();
        }}
      >
        {content}
      </a>
    );
  if (nativeSource)
    return (
      <>
        <button
          type="button"
          className={styles.fileAttachment}
          aria-label={`Download ${displayName}`}
          title={displayName}
          onClick={download}
        >
          {content}
        </button>
        {downloadError && <span role="alert">Download failed</span>}
      </>
    );
  return (
    <a
      className={styles.fileAttachment}
      href={source}
      download={attachment.name ?? ""}
      aria-label={`Download ${displayName}`}
      title={displayName}
    >
      {content}
    </a>
  );
}

function UnavailableFileAttachment({
  displayName,
  attachment,
}: {
  displayName: string;
  attachment: Attachment;
}) {
  return (
    <span className={styles.fileAttachment} role="status" title={displayName}>
      <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>File unavailable</span>
      </span>
    </span>
  );
}
