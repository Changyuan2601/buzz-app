import { useEffect, useState } from "react";
import type { RelaySession } from "../relay/session";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { WorkspaceFields } from "./WorkspaceFields";
import {
  emptyWorkspace,
  loadSessionSetup,
  readWorkspace,
  workspaceCanvas,
} from "./workspace";

/** Edits only the local draft; first-send owns remote setup and its retry receipt. */
export function DraftSessionSettings({
  session,
  sectionId,
  canvas,
  save,
  close,
}: {
  session: RelaySession;
  sectionId?: string | undefined;
  canvas?: string | undefined;
  save(canvas: string): void;
  close(): void;
}) {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const [raw, setRaw] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed settings read.
  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      try {
        const content =
          canvas ??
          (sectionId
            ? (await loadSessionSetup(session, sectionId)).canvas
            : "");
        if (!active) return;
        try {
          setWorkspace(readWorkspace(content));
        } catch {
          setRaw(content);
        }
        setLoaded(true);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
    };
  }, [session, sectionId, canvas, attempt]);
  return (
    <Dialog
      open
      height="stable"
      title="Session settings"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="prominent"
            disabled={!loaded}
            onClick={() => {
              try {
                save(
                  raw === undefined
                    ? workspaceCanvas(workspace)
                    : workspaceCanvas({ folders: [], canvas: raw }),
                );
                close();
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              }
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      {loaded ? (
        raw === undefined ? (
          <WorkspaceFields value={workspace} onChange={setWorkspace} />
        ) : (
          <Field label="Canvas">
            <Textarea
              rows={12}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
            />
          </Field>
        )
      ) : (
        <p role="status">Loading settings…</p>
      )}
      {error && <p role="alert">{error}</p>}
      {!loaded && error && (
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Retry settings
        </Button>
      )}
    </Dialog>
  );
}
