import { pngChunks } from "../../features/messages/image-metadata";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { messageViewKey } from "../../features/messages/view-key";
import { relayOrigin } from "../../features/communities/destination";
import {
  readSnapshotAttachment,
  subscribeSnapshotPreview,
  type SnapshotPreviewRequest,
} from "../../features/agents/snapshot-preview";
import { decodeTeamFile } from "../../features/agents/team-encoding";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import { AgentSnapshotImport } from "./AgentSnapshots";
import { TeamImportDialog } from "./TeamImportDialog";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

export function SnapshotPreview({
  relay,
  control,
}: {
  relay: RelayData;
  control: AgentControl;
}) {
  const connection = useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
  return connection.status === "ready" ? (
    <SessionSnapshotPreview
      key={messageViewKey(connection.session, connection.scope)}
      session={connection.session}
      control={control}
    />
  ) : null;
}

function SessionSnapshotPreview({
  session,
  control,
}: {
  session: RelaySession;
  control: AgentControl;
}) {
  const [request, setRequest] = useState<SnapshotPreviewRequest>();
  useEffect(
    () =>
      subscribeSnapshotPreview(session, (value) =>
        setRequest((current) => current ?? value),
      ),
    [session],
  );
  return request ? (
    <ReceivedSnapshot
      key={request.attachment.url}
      session={session}
      control={control}
      request={request}
      close={() => setRequest(undefined)}
    />
  ) : null;
}

function ReceivedSnapshot({
  session,
  control,
  request,
  close,
}: {
  session: RelaySession;
  control: AgentControl;
  request: SnapshotPreviewRequest;
  close(): void;
}) {
  const [bytes, setBytes] = useState<Uint8Array>();
  const [team, setTeam] = useState<TeamSnapshot>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the failed authenticated read.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void (async () => {
      try {
        const value = await readSnapshotAttachment(
          session,
          request.attachment,
          controller.signal,
        );
        const kind = request.kind ?? snapshotKind(value);
        if (kind === "team") {
          if (!control.previewTeam)
            throw new Error("Team preview is unavailable.");
          const preview = await control.previewTeam(decodeTeamFile(value));
          controller.signal.throwIfAborted();
          setTeam(preview);
        } else setBytes(value);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Snapshot preview failed.",
          );
      }
    })();
    return () => controller.abort();
  }, [session, control, request, attempt]);
  const owner = session.viewer;
  const destination = owner
    ? relayOrigin(session.scope.slice(0, -(owner.length + 1)))
    : "";
  if (owner && destination && bytes)
    return (
      <AgentSnapshotImport
        control={control}
        destination={destination}
        owner={owner}
        receivedBytes={bytes}
        onClose={close}
      />
    );
  if (owner && destination && team)
    return (
      <TeamImportDialog
        snapshot={team}
        control={control}
        destination={destination}
        owner={owner}
        kit={session.channelKit}
        close={close}
      />
    );
  return (
    <Dialog
      open
      title="Preview snapshot"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {error && (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          )}
        </>
      }
    >
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <p role="status">Loading snapshot…</p>
      )}
    </Dialog>
  );
}

/** Classify only; the matching owner still validates the entire manifest. */
function snapshotKind(bytes: Uint8Array): "agent" | "team" {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.every((byte, index) => bytes[index] === byte)) {
    const chunks = pngChunks(bytes);
    for (const kind of ["agent", "team"] as const) {
      const keyword = `buzz_${kind}_snapshot\0`;
      if (
        chunks.some(
          (chunk) =>
            chunk.kind === "tEXt" &&
            new TextDecoder().decode(
              chunk.payload.subarray(0, keyword.length),
            ) === keyword,
        )
      )
        return kind;
    }
  } else {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Unsupported snapshot format.");
    }
    if (value && typeof value === "object" && "format" in value) {
      if (value.format === "buzz-agent-snapshot") return "agent";
      if (value.format === "buzz-team-snapshot") return "team";
    }
  }
  throw new Error("Unsupported snapshot format.");
}
