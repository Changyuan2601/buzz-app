import { ChannelDurationField } from "../../bundled/channels/ChannelDurationField";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../relay/channel-details-protocol";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../relay/work-sessions";
import { useEffect, useState, type ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./WorkspaceSettings.module.css";
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
  personal = false,
  canvas,
  name = "",
  save,
  close,
  ttlSeconds,
  parentLinked = false,
  finalFocus,
}: {
  session: RelaySession;
  sectionId?: string | undefined;
  personal?: boolean;
  canvas?: string | undefined;
  name?: string | undefined;
  ttlSeconds?: number | undefined;
  parentLinked?: boolean;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
  save(canvas: string, ttlSeconds?: number, name?: string): void;
  close(): void;
}) {
  const [value, setValue] = useState(typeof name === "string" ? name : "");
  const normalized = canonicalDetailsName(value);
  const nameError = normalized
    ? detailsDraftErrors({
        name: normalized,
        description: "",
        visibility: "private",
      }).name
      ? "Use a session name of at most 120 characters."
      : undefined
    : undefined;
  const [ttl, setTtl] = useState(ttlSeconds);
  const [temporaryTtl, setTemporaryTtl] = useState(
    ttlSeconds ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const lifetimeError = detailsDraftErrors({
    name: "Session",
    description: "",
    visibility: "private",
    ttlSeconds: ttl,
  }).lifetime;
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
            ? (await loadSessionSetup(session, sectionId, personal)).canvas
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
  }, [session, sectionId, personal, canvas, attempt]);
  return (
    <Dialog
      open
      finalFocus={finalFocus}
      title="Session settings"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="prominent"
            disabled={
              !loaded || !!nameError || (!parentLinked && !!lifetimeError)
            }
            onClick={() => {
              try {
                save(
                  raw === undefined
                    ? workspaceCanvas(workspace)
                    : workspaceCanvas({ folders: [], canvas: raw }),
                  parentLinked ? undefined : ttl,
                  normalized,
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
      <div className={styles.sections}>
        <Field label="Session name (optional)" error={nameError}>
          <Input
            value={value}
            disabled={!loaded}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        {loaded ? (
          raw === undefined ? (
            <WorkspaceFields value={workspace} onChange={setWorkspace} />
          ) : (
            <Field label="Instructions">
              <Textarea
                rows={12}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
              />
            </Field>
          )
        ) : (
          !error && <p role="status">Loading settings…</p>
        )}
        {!parentLinked && (
          <ChannelDurationField
            label="Lifetime"
            temporary={ttl !== undefined}
            ttlSeconds={temporaryTtl}
            disabled={!loaded}
            error={lifetimeError}
            onChange={(next) => {
              setTtl(next);
              if (next !== undefined) setTemporaryTtl(next);
            }}
          />
        )}
        {error && <p role="alert">{error}</p>}
        {!loaded && error && (
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Retry settings
          </Button>
        )}
      </div>
    </Dialog>
  );
}
