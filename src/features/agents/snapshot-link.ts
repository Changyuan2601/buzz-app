import type { RelaySession } from "../relay/session";
import type { UploadedAttachment } from "../relay/attachments";
import type { EncodedSnapshot } from "./snapshot-send";
import { snapshotFile } from "./snapshot-file";

/** Reference clipboard payload: the visible link is the name, plain text is the media URL. */
export function snapshotClipboardHtml(
  attachment: UploadedAttachment,
  displayName: string,
) {
  const payload = encodeURIComponent(
    JSON.stringify({
      version: 1,
      displayName,
      filename: attachment.name,
      sha256: attachment.sha256,
      size: attachment.size,
      type: attachment.type,
      url: attachment.url,
    }),
  );
  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<a data-buzz-agent-snapshot="${payload}" href="${escapeHtml(attachment.url)}">${escapeHtml(displayName)}</a>`;
}

/** Start clipboard.write in the click gesture; encoding/upload resolve its data later. */
export async function copySnapshotLink({
  session,
  snapshot,
  displayName,
  signal,
}: {
  session: Pick<RelaySession, "snapshotUpload">;
  snapshot: Promise<EncodedSnapshot>;
  displayName: string;
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  signal = AbortSignal.any([signal, controller.signal]);
  signal.throwIfAborted();
  const upload = session.snapshotUpload;
  if (!upload) throw new Error("Snapshot uploads are unavailable.");
  const attachment = snapshot.then(async (encoded) => {
    signal.throwIfAborted();
    const result = await upload.upload(snapshotFile(encoded), signal);
    signal.throwIfAborted();
    return result;
  });
  const text = attachment.then(
    (value) => new Blob([value.url], { type: "text/plain" }),
  );
  const html = attachment.then(
    (value) =>
      new Blob([snapshotClipboardHtml(value, displayName)], {
        type: "text/html",
      }),
  );
  // Observe both data promises even if the platform rejects the write immediately.
  const data = Promise.all([text, html]);
  void data.catch(() => {});
  try {
    const write = navigator.clipboard.write([
      new ClipboardItem({ "text/plain": text, "text/html": html }),
    ]);
    await Promise.all([write, data]);
    signal.throwIfAborted();
  } catch (reason) {
    controller.abort();
    throw reason;
  }
}
