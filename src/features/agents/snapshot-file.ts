import {
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
} from "./snapshot";
import {
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";
import { UploadError } from "../relay/attachments";
import type { EncodedSnapshot } from "./snapshot-send";

/** Portable snapshot policy shared by DM delivery and standalone links. */
export function validateSnapshotFile(file: File) {
  const maxBytes = file.name.endsWith(".team.png")
    ? MAX_TEAM_SNAPSHOT_PNG_BYTES
    : file.name.endsWith(".team.json")
      ? MAX_TEAM_SNAPSHOT_JSON_BYTES
      : file.name.endsWith(".json")
        ? MAX_AGENT_SNAPSHOT_JSON_BYTES
        : MAX_AGENT_SNAPSHOT_PNG_BYTES;
  if (file.size < 1 || file.size > maxBytes) throw new UploadError("size");
  if (
    !(
      (file.type === "image/png" && file.name.endsWith(".png")) ||
      (file.type === "application/json" && file.name.endsWith(".json"))
    )
  )
    throw new UploadError("rejected");
}

export function snapshotFile(snapshot: EncodedSnapshot) {
  const file = new File(
    [Uint8Array.from(snapshot.fileBytes)],
    snapshot.fileName,
    {
      type: snapshot.fileName.endsWith(".png")
        ? "image/png"
        : "application/json",
    },
  );
  validateSnapshotFile(file);
  return file;
}
