import { useState } from "react";
import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  requestSnapshotPreview,
  snapshotAttachmentKind,
} from "../agents/snapshot-preview";
import { FileAttachment } from "./FileAttachment";
import { Button } from "../../shared/design-system/ui/Button";

export function SnapshotAttachment({
  attachment,
  session,
  cached,
}: {
  attachment: Attachment;
  session: RelaySession;
  cached: boolean;
}) {
  const [error, setError] = useState("");
  return (
    <div>
      <FileAttachment
        attachment={attachment}
        source={cached ? undefined : session.media(attachment.url)}
        onOpenLink={() => false}
      />
      <Button
        disabled={cached || !session.media(attachment.url)}
        onClick={() => {
          setError("");
          try {
            requestSnapshotPreview(session, attachment);
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Snapshot preview is unavailable.",
            );
          }
        }}
      >
        {snapshotAttachmentKind(attachment) === "team"
          ? "Add team"
          : "Add agent"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
