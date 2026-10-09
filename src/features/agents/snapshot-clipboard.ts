import {
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
} from "./snapshot";
import {
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";
import type { RelaySession } from "../relay/session";
import {
  validateUploadResult,
  type UploadedAttachment,
} from "../relay/attachments";
import { canPreviewSnapshotLink } from "./snapshot-preview";

/** Clipboard metadata is untrusted; only this session's authenticated media is eligible. */
export function parseSnapshotClipboard(
  html: string,
  session: RelaySession,
): UploadedAttachment | undefined {
  if (html.length > 16_384) return;
  const encoded = /\bdata-buzz-agent-snapshot=(?:"([^"]+)"|'([^']+)')/i.exec(
    html,
  );
  if (!encoded) return;
  try {
    const value = JSON.parse(
      decodeURIComponent(encoded[1] ?? encoded[2] ?? ""),
    );
    if (
      value?.version !== 1 ||
      typeof value.displayName !== "string" ||
      !value.displayName.trim() ||
      value.displayName.length > 200 ||
      typeof value.filename !== "string" ||
      value.filename.length > 255 ||
      /[\\/]/.test(value.filename) ||
      Array.from(value.filename as string).some(
        (char) => char.charCodeAt(0) < 32,
      ) ||
      !/\.(agent|team)\.(png|json)$/.test(value.filename) ||
      typeof value.url !== "string" ||
      !canPreviewSnapshotLink(session, value.url) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 1 ||
      value.size >
        (value.filename.includes(".agent.")
          ? value.filename.endsWith(".json")
            ? MAX_AGENT_SNAPSHOT_JSON_BYTES
            : MAX_AGENT_SNAPSHOT_PNG_BYTES
          : value.filename.endsWith(".json")
            ? MAX_TEAM_SNAPSHOT_JSON_BYTES
            : MAX_TEAM_SNAPSHOT_PNG_BYTES) ||
      value.type !==
        (value.filename.endsWith(".png") ? "image/png" : "application/json")
    )
      return;
    return validateUploadResult(
      value,
      new URL(value.url).origin,
      value.size,
      value.filename,
    );
  } catch {
    return;
  }
}
