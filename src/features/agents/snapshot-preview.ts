import {
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
} from "./snapshot";
import {
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";
import { invoke } from "@tauri-apps/api/core";
import { nativeIdentityEnabled } from "../identity/service";
import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  isNativeMediaSource,
  isProxySource,
} from "../messages/attachment-source";

export type SnapshotPreviewRequest = Readonly<{
  attachment: Attachment;
  kind?: "agent" | "team";
}>;

const listeners = new WeakMap<
  RelaySession,
  (request: SnapshotPreviewRequest) => void
>();

/** Filenames select a preview only. The corresponding importer validates the bytes. */
export function snapshotAttachmentKind(
  attachment: Attachment,
): "agent" | "team" | undefined {
  if (
    attachment.name?.endsWith(".agent.png") ||
    attachment.name?.endsWith(".agent.json")
  )
    return "agent";
  if (
    attachment.name?.endsWith(".team.png") ||
    attachment.name?.endsWith(".team.json")
  )
    return "team";
  return undefined;
}

export function subscribeSnapshotPreview(
  session: RelaySession,
  listener: (request: SnapshotPreviewRequest) => void,
) {
  listeners.set(session, listener);
  return () => {
    if (listeners.get(session) === listener) listeners.delete(session);
  };
}

export function requestSnapshotPreview(
  session: RelaySession,
  attachment: Attachment,
) {
  const kind = snapshotAttachmentKind(attachment);
  const listener = listeners.get(session);
  if (!kind || !listener) throw new Error("Snapshot preview is unavailable.");
  listener({ attachment, kind });
}

/** An explicit link-preview action is offered only for authenticated relay media. */
export function canPreviewSnapshotLink(
  session: RelaySession,
  url: string,
): boolean {
  const source = session.media(url);
  return (
    !!source &&
    (isNativeMediaSource(source) || isProxySource(source)) &&
    /^https:\/\/[^/]+\/media\/[0-9a-f]{64}(?:\.(?:png|json))?$/.test(url)
  );
}

export function requestSnapshotLinkPreview(session: RelaySession, url: string) {
  const listener = listeners.get(session);
  if (!listener || !canPreviewSnapshotLink(session, url))
    throw new Error("Snapshot preview is unavailable.");
  listener({ attachment: { url, kind: "file" } });
}

/** Read only through the host's authenticated media source, never the remote URL. */
export async function readSnapshotAttachment(
  session: RelaySession,
  attachment: Attachment,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const source = session.media(attachment.url);
  if (!source || !(isNativeMediaSource(source) || isProxySource(source)))
    throw new Error("Snapshot media is unavailable.");
  const url = new URL(attachment.url);
  const hash = /^\/media\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/.exec(
    url.pathname,
  )?.[1];
  if (!hash || url.search || url.hash || url.username || url.password)
    throw new Error("Invalid snapshot media URL.");
  // These are the current importer limits, not the sender's size claim.
  const kind = snapshotAttachmentKind(attachment);
  const limit =
    kind === "agent"
      ? attachment.name?.endsWith(".json")
        ? MAX_AGENT_SNAPSHOT_JSON_BYTES
        : MAX_AGENT_SNAPSHOT_PNG_BYTES
      : attachment.name?.endsWith(".json")
        ? MAX_TEAM_SNAPSHOT_JSON_BYTES
        : MAX_TEAM_SNAPSHOT_PNG_BYTES;
  let bytes: Uint8Array<ArrayBuffer>;
  if (isNativeMediaSource(source) && nativeIdentityEnabled()) {
    const body = await invoke<number[]>("media_snapshot_read", {
      source,
      maxBytes: limit,
    });
    signal.throwIfAborted();
    if (body.length > limit)
      throw new Error("Snapshot exceeds the size limit.");
    bytes = Uint8Array.from(body);
  } else {
    const response = await fetch(source, { signal });
    if (!response.ok || !response.body)
      throw new Error(
        "Couldn’t load snapshot. Check your connection and try again.",
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error("Snapshot exceeds the size limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    signal.throwIfAborted();
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  signal.throwIfAborted();
  if (
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ) !== hash
  )
    throw new Error("Snapshot checksum does not match the media link.");
  return bytes;
}
