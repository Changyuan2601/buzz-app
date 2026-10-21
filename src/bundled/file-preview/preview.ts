import type { Attachment } from "../../features/relay/contracts";
import { safeMessageUrl } from "../../features/relay/message-content";
import {
  isNativeMediaSource,
  isProxySource,
} from "../../features/messages/attachment-source";

const PREFIX = "buzz-file-preview:";
const MAX_BYTES = 100_000;
const TOO_LARGE =
  "This file exceeds the 100 KB preview limit. Download it instead.";

export function previewFormat(attachment: Attachment) {
  if (
    attachment.kind !== "file" ||
    !safeMessageUrl(attachment.url) ||
    (attachment.size !== undefined && attachment.size > MAX_BYTES)
  )
    return undefined;
  const mime = attachment.mime?.split(";")[0]?.trim().toLowerCase();
  if (
    /\.(md|markdown)$/i.test(attachment.name ?? "") ||
    mime === "text/markdown" ||
    mime === "text/x-markdown"
  )
    return "markdown";
  if (/\.txt$/i.test(attachment.name ?? "") || mime === "text/plain")
    return "text";
  return undefined;
}

export function previewSource(source: string) {
  return isNativeMediaSource(source) || isProxySource(source);
}

export function previewTarget(attachment: Attachment, source: string) {
  const params = new URLSearchParams({ url: attachment.url, source });
  if (attachment.name) params.set("name", attachment.name);
  if (attachment.mime) params.set("mime", attachment.mime);
  if (attachment.size !== undefined)
    params.set("size", String(attachment.size));
  return PREFIX + params.toString();
}

export function parsePreviewTarget(target: string) {
  if (!target.startsWith(PREFIX)) return undefined;
  const params = new URLSearchParams(target.slice(PREFIX.length));
  const url = safeMessageUrl(params.get("url") ?? "");
  const source = params.get("source");
  if (!url || !source || !previewSource(source)) return undefined;
  const name = params.get("name");
  const mime = params.get("mime");
  const size = params.get("size");
  const bytes = size === null ? undefined : Number(size);
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0))
    return undefined;
  const attachment: Attachment = {
    kind: "file",
    url,
    ...(name ? { name } : {}),
    ...(mime ? { mime } : {}),
    ...(bytes !== undefined ? { size: bytes } : {}),
  };
  const format = previewFormat(attachment);
  return format ? { attachment, source, format } : undefined;
}

export async function loadPreview(source: string, signal: AbortSignal) {
  const response = await fetch(
    isNativeMediaSource(source) ? `${source}?preview` : source,
    { signal },
  );
  if (response.status === 413) throw new Error(TOO_LARGE);
  if (!response.ok) throw new Error("The file could not be loaded. Try again.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(TOO_LARGE);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file could not be loaded. Try again.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error(TOO_LARGE);
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        throw new Error("This file is not UTF-8 text. Download it instead.");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new Error("This file is not UTF-8 text. Download it instead.");
    }
    if (text.includes("\0"))
      throw new Error("This file is not plain text. Download it instead.");
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
