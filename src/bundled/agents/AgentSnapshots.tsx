import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import type { AgentControl, AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import { relayOrigin } from "../../features/communities/destination";
import {
  avatarPreview,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  MAX_AGENT_SNAPSHOT_FILE_BYTES,
  parseAgentSnapshot,
  snapshotPngArtwork,
  snapshotImportEdit,
  snapshotLimitations,
  type AgentSnapshot,
  type MemoryLevel,
} from "../../features/agents/snapshot";

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes)], { type: mime }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function AgentSnapshotExport({
  agent,
  defaultSessionPolicy,
  session,
  destination,
  onClose,
}: {
  agent: AgentView;
  defaultSessionPolicy?: "channel" | "thread" | undefined;
  session?: RelaySession | undefined;
  destination: string;
  onClose(): void;
}) {
  const [level, setLevel] = useState<MemoryLevel>("none");
  const [format, setFormat] = useState<"json" | "png">("png");
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  let review: AgentSnapshot | undefined;
  let reviewError = "";
  try {
    review = buildAgentSnapshot(agent, "none", [], defaultSessionPolicy);
  } catch (cause) {
    reviewError =
      cause instanceof Error ? cause.message : "Export unavailable.";
  }
  // Approval covers the raw artwork source too: PNG export may embed an HTTPS
  // picture URL that the portable JSON manifest deliberately omits.
  const reviewKey = review
    ? JSON.stringify([
        agent.id,
        agent.pubkey,
        agent.relayUrl,
        destination,
        agent.picture,
        review,
      ])
    : null;
  const currentKey = useRef(reviewKey);
  const changedDuringExport = useRef(false);
  const retired = useRef(false);
  const activeMemoryView = useRef<
    ReturnType<RelaySession["agentMemories"]["open"]> | undefined
  >(undefined);
  const disposeMemoryView = (
    view: ReturnType<RelaySession["agentMemories"]["open"]>,
  ) => {
    if (activeMemoryView.current !== view) return;
    activeMemoryView.current = undefined;
    view.dispose();
  };
  useLayoutEffect(() => {
    retired.current = false;
    return () => {
      retired.current = true;
      const view = activeMemoryView.current;
      if (view) {
        activeMemoryView.current = undefined;
        view.dispose();
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (currentKey.current !== reviewKey) {
      currentKey.current = reviewKey;
      changedDuringExport.current = true;
      setReviewedKey(null);
      setConfirmedKey(null);
    }
  }, [reviewKey]);
  const reviewed = reviewKey !== null && reviewedKey === reviewKey;
  const confirmed =
    reviewed && confirmedKey === JSON.stringify([reviewKey, level]);
  const exportFile = async () => {
    const approvedKey = reviewKey;
    if (
      pending ||
      !reviewed ||
      !review ||
      !approvedKey ||
      (level !== "none" && !confirmed)
    )
      return;
    setPending(true);
    changedDuringExport.current = false;
    setError("");
    try {
      let entries: { slug: string; body: string }[] = [];
      if (level !== "none") {
        if (
          !session ||
          relayOrigin(agent.relayUrl) !== relayOrigin(destination)
        )
          throw new Error("Memory reads require the source agent's community.");
        const view = session.agentMemories.open(agent.pubkey);
        activeMemoryView.current = view;
        try {
          await view.refresh();
          const state = view.snapshot();
          if (
            state.status !== "ready" ||
            !state.listing ||
            state.listing.partial
          )
            throw new Error(
              "Couldn’t load complete memories. Check your connection and try again.",
            );
          entries = state.listing.entries.map(({ slug, body }) => ({
            slug,
            body,
          }));
        } finally {
          disposeMemoryView(view);
        }
      }
      const snapshot = {
        ...review,
        memory: {
          level,
          entries: entries.filter(
            ({ slug }) => level === "everything" || slug === "core",
          ),
        },
      };
      // Memory is added only after consent; validate the complete artifact as
      // well as the configuration that was reviewed before sharing it.
      parseAgentSnapshot(new TextEncoder().encode(JSON.stringify(snapshot)));
      let artwork: Uint8Array | undefined;
      if (format === "png" && agent.picture) {
        try {
          const image = new Image();
          image.crossOrigin = "anonymous";
          image.src =
            avatarPreview(agent.picture, agent.relayUrl) ?? agent.picture;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 512;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          context.drawImage(image, 0, 0, 512, 512);
          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (value) =>
                value
                  ? resolve(value)
                  : reject(new Error("Artwork unavailable")),
              "image/png",
            ),
          );
          artwork = new Uint8Array(await blob.arrayBuffer());
          canvas.width = canvas.height = 0;
        } catch {
          /* Missing or cross-origin artwork uses the placeholder. */
        }
      }
      // A refresh while memory or artwork was loading must not share a newly
      // unreviewed source under an earlier approval.
      if (
        retired.current ||
        changedDuringExport.current ||
        currentKey.current !== approvedKey
      ) {
        throw new Error(
          "Agent configuration changed. Review it again before exporting.",
        );
      }
      const bytes = encodeAgentSnapshot(snapshot, format, artwork);
      download(
        bytes,
        `${agent.name.replace(/[^a-zA-Z0-9_-]+/g, "-")}.agent.${format}`,
        format === "png" ? "image/png" : "application/json",
      );
      onClose();
    } catch (cause) {
      if (!retired.current)
        setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      if (!retired.current) setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      preventClose={pending}
      title={`Export ${agent.name}`}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              pending ||
              !review ||
              !reviewed ||
              (level !== "none" && !confirmed)
            }
            onClick={() => void exportFile()}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="flex items-center gap-2">
          Memories
          <select
            aria-label="Memories"
            value={level}
            disabled={
              pending ||
              !session ||
              !destination ||
              relayOrigin(agent.relayUrl) !== relayOrigin(destination)
            }
            onChange={(event) => {
              setConfirmedKey(null);
              setLevel(event.target.value as MemoryLevel);
            }}
          >
            <option value="none">Agent only</option>
            <option value="core">Agent + core memory</option>
            <option value="everything">Agent + all memories</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          File format
          <select
            aria-label="File format"
            value={format}
            disabled={pending}
            onChange={(event) =>
              setFormat(event.target.value as "json" | "png")
            }
          >
            <option value="png">PNG</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <p>
          Portable configuration includes the agent name, instructions, model,
          provider, worker count and avatar URL when present. PNG exports may
          also embed artwork from the source avatar URL shown below. Review the
          actual values before sharing: free text can contain secrets that
          automated checks cannot detect.
        </p>
        <details>
          <summary>Review portable configuration</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(review, null, 2)}
          </pre>
          {agent.picture && !review?.profile.avatarUrl && (
            <p className="break-all">Artwork source: {agent.picture}</p>
          )}
        </details>
        <label>
          <input
            type="checkbox"
            checked={reviewed}
            disabled={pending}
            onChange={(event) =>
              setReviewedKey(event.target.checked ? reviewKey : null)
            }
          />{" "}
          I reviewed the portable configuration and understand it may contain
          private information.
        </label>
        {level !== "none" && (
          <>
            <p role="alert">
              Memory is stored as <strong>plaintext</strong> in the snapshot.
              Only share it with people you trust.
            </p>
            <p>
              {level === "core"
                ? "Core memory"
                : "Core memory and all mem/* entries"}{" "}
              will be included.
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={pending}
                onChange={(event) =>
                  setConfirmedKey(
                    event.target.checked && reviewed
                      ? JSON.stringify([reviewKey, level])
                      : null,
                  )
                }
              />{" "}
              I confirm that I want to include memory in this snapshot.
            </label>
          </>
        )}
        {reviewError && <p role="alert">{reviewError}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

export function AgentSnapshotImport({
  control,
  destination,
  owner,
  receivedBytes,
  onClose,
}: {
  control: AgentControl;
  destination: string;
  owner: string;
  /** Received attachment bytes are previewed only; importing still requires an explicit click. */
  receivedBytes?: Uint8Array;
  onClose(): void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  const [artwork, setArtwork] = useState<Uint8Array>();
  const [restoreMemory, setRestoreMemory] = useState(false);
  const [fileError, setFileError] = useState("");
  const [memoryError, setMemoryError] = useState("");
  const [profileResult, setProfileResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [createdId, setCreatedId] = useState<string>();
  const [memoryRetry, setMemoryRetry] = useState<{
    id: string;
    entries: AgentSnapshot["memory"]["entries"];
  }>();
  const [profilePublished, setProfilePublished] = useState(false);
  useEffect(() => {
    if (!receivedBytes) return;
    requestId.current = crypto.randomUUID();
    setRestoreMemory(false);
    let cancelled = false;
    const preview = async () => {
      try {
        const parsed = parseAgentSnapshot(receivedBytes);
        const pixels = parsed.profile.avatarDataUrl
          ? undefined
          : await snapshotPngArtwork(receivedBytes);
        if (cancelled) return;
        setSnapshot(parsed);
        setArtwork(pixels);
        setFileError("");
      } catch (error) {
        if (cancelled) return;
        setSnapshot(undefined);
        setArtwork(undefined);
        setFileError(
          error instanceof Error ? error.message : "Invalid snapshot JSON.",
        );
      }
    };
    void preview();
    return () => {
      cancelled = true;
    };
  }, [receivedBytes]);
  const read = async (file?: File) => {
    setFileError("");
    setSnapshot(undefined);
    setArtwork(undefined);
    setRestoreMemory(false);
    const readId = crypto.randomUUID();
    requestId.current = readId;
    if (!file) return;
    if (file.size > MAX_AGENT_SNAPSHOT_FILE_BYTES) {
      setFileError("Snapshot exceeds the size limit.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseAgentSnapshot(bytes);
      const pixels = parsed.profile.avatarDataUrl
        ? undefined
        : await snapshotPngArtwork(bytes);
      if (requestId.current === readId) {
        setSnapshot(parsed);
        setArtwork(pixels);
      }
    } catch (error) {
      if (requestId.current !== readId) return;
      setFileError(
        error instanceof Error ? error.message : "Invalid snapshot JSON.",
      );
    }
  };
  const unsupported = snapshot ? snapshotLimitations(snapshot) : [];
  const restore = async (
    id: string,
    entries: AgentSnapshot["memory"]["entries"],
  ) => {
    if (!control.writeSnapshotMemory) return;
    try {
      const outcome = await control.writeSnapshotMemory(id, entries);
      const expected = entries.length;
      if (
        outcome.total !== expected ||
        outcome.written !== expected ||
        outcome.errors.length
      ) {
        setMemoryRetry({ id, entries });
        setMemoryError(
          `Memory partially restored: ${outcome.written} of ${expected} entries confirmed. The agent exists but some memory entries were not confirmed. ${outcome.errors.join("; ")}`,
        );
      } else {
        setMemoryRetry(undefined);
        setMemoryError("");
      }
    } catch (error) {
      setMemoryRetry({ id, entries });
      setMemoryError(
        `Memory restoration unconfirmed for ${entries.length} entries. The agent exists; check its memories before retrying. ${error instanceof Error ? error.message : ""}`,
      );
    }
  };
  const retryMemory = async () => {
    if (busy || !memoryRetry || !createdId || memoryRetry.id !== createdId)
      return;
    setBusy(true);
    try {
      if (control.snapshot().status !== "ready") {
        await control.refresh();
        if (control.snapshot().status !== "ready") {
          setMemoryError(
            "Could not confirm local agent status. Check your connection and retry memory restore for this agent.",
          );
          return;
        }
      }
      await restore(memoryRetry.id, memoryRetry.entries);
    } catch {
      setMemoryError(
        "Could not refresh local agent status. Check your connection and retry memory restore for this agent.",
      );
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (
      createdId ||
      unsupported.length > 0 ||
      !snapshot ||
      busy ||
      !control.create ||
      !destination ||
      !owner ||
      (restoreMemory &&
        snapshot.memory.entries.length > 0 &&
        !control.writeSnapshotMemory)
    )
      return;
    setBusy(true);
    setFileError("");
    try {
      const edit = snapshotImportEdit(snapshot, control.snapshot().data ?? {});
      let picture = edit.picture;
      if (snapshot.profile.avatarDataUrl) {
        const [header, encoded] = snapshot.profile.avatarDataUrl.split(",", 2);
        const mime = header?.slice("data:".length).split(";", 1)[0];
        if (!encoded || !mime)
          throw new Error("Snapshot avatar data is malformed.");
        const bytes = Uint8Array.from(atob(encoded), (char) =>
          char.charCodeAt(0),
        );
        picture = await uploadAvatar(
          new File([bytes], "snapshot-avatar", { type: mime }),
          destination,
          new AbortController().signal,
        );
      } else if (artwork) {
        picture = await uploadAvatar(
          new File([Uint8Array.from(artwork)], "snapshot-avatar.png", {
            type: "image/png",
          }),
          destination,
          new AbortController().signal,
        );
      }
      const agent = await control.create(
        requestId.current,
        destination,
        owner,
        { ...edit, ...(picture ? { picture } : {}) },
      );
      setCreatedId(agent.id);
      setResult(
        `${agent.name} was created successfully. Review settings and configure local credentials in Edit, publish its profile, then Start the agent.`,
      );
      if (
        restoreMemory &&
        snapshot.memory.entries.length &&
        control.writeSnapshotMemory
      ) {
        await restore(agent.id, snapshot.memory.entries);
      }
    } catch (error) {
      await control.refresh();
      setFileError(
        `${error instanceof Error ? error.message : "Import failed."} Check Agents before retrying to avoid a duplicate identity.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      preventClose={busy}
      title={result ? "Agent imported" : "Import agent snapshot"}
      actions={
        result ? (
          <>
            {memoryRetry && (
              <Button
                disabled={busy || !control.writeSnapshotMemory}
                onClick={() => void retryMemory()}
              >
                Retry memory restore
              </Button>
            )}
            <Button disabled={busy} onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={
                busy ||
                !!createdId ||
                unsupported.length > 0 ||
                !snapshot ||
                !destination ||
                !owner ||
                (restoreMemory &&
                  snapshot.memory.entries.length > 0 &&
                  !control.writeSnapshotMemory)
              }
              variant="primary"
              onClick={() => void create()}
            >
              Import
            </Button>
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </>
        )
      }
    >
      {result ? (
        <>
          <p>{result}</p>
          {createdId && control.publishProfile && !profilePublished && (
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void control
                  .publishProfile?.(createdId)
                  .then(
                    () => {
                      setProfilePublished(true);
                      setProfileResult("Profile published.");
                    },
                    () =>
                      setProfileResult(
                        "Profile publication unconfirmed. Review agent status and retry from Manage.",
                      ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Publish profile
            </Button>
          )}
          {fileError && <p role="alert">{fileError}</p>}
          {memoryError && <p role="alert">{memoryError}</p>}
          {profileResult && (
            <p role={profilePublished ? "status" : "alert"}>{profileResult}</p>
          )}
        </>
      ) : (
        <div className="space-y-4">
          {!receivedBytes && (
            <>
              <input
                ref={fileInput}
                hidden
                type="file"
                disabled={busy}
                accept=".json,.png,.agent.json,.agent.png,application/json,image/png"
                aria-label="Agent snapshot"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void read(file);
                }}
              />
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                Choose file
              </Button>
            </>
          )}
          {snapshot && (
            <>
              <h3>{snapshot.profile.displayName}</h3>
              <section>
                <p>Agent instructions</p>
                <p>
                  Review the instructions this agent will follow after import.
                </p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                  {snapshot.definition.systemPrompt ||
                    "No system prompt included."}
                </pre>
              </section>
              <p>
                A new agent will be created with a fresh keypair. The imported
                agent is independent of the source — identity never travels.
              </p>
              {snapshot.memory.entries.length ? (
                <div>
                  <p role="alert">
                    This snapshot includes{" "}
                    <strong>
                      {snapshot.memory.entries.length}{" "}
                      {snapshot.memory.level === "core" ? "core" : "all"} memory{" "}
                      {snapshot.memory.entries.length === 1
                        ? "entry"
                        : "entries"}
                    </strong>
                    . Memory is plaintext in the file. It is omitted from import
                    unless you explicitly choose to restore it.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={restoreMemory}
                      disabled={busy || !control.writeSnapshotMemory}
                      onChange={(event) =>
                        setRestoreMemory(event.target.checked)
                      }
                    />{" "}
                    Restore memory under the new agent identity
                  </label>
                  {!control.writeSnapshotMemory && (
                    <p role="alert">
                      Memory restoration is unavailable on this host. You can
                      still import the agent configuration without memory.
                    </p>
                  )}
                </div>
              ) : (
                <p>No memory included — config only.</p>
              )}
              {unsupported.length > 0 && (
                <p role="alert">
                  Import is blocked: {unsupported.join("; ")}. These settings
                  cannot be applied faithfully on this host.
                </p>
              )}
              <p>
                Runtime: {snapshot.definition.runtime ?? "unspecified"}.
                Response policy:{" "}
                {snapshot.definition.respondTo ?? "unspecified"}. Parallelism:{" "}
                {snapshot.definition.parallelism ?? "unspecified"}. Session
                policy: {snapshot.definition.sessionPolicy ?? "channel"}.
              </p>
              <p>
                Review imported model and harness settings in Edit. Local
                provider credentials and environment overrides must be
                configured on this device.
              </p>
              <details>
                <summary>Full embedded manifest</summary>
                <p>
                  This is the complete portable payload decoded from the file.
                  Source identity is not part of the snapshot format.
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(snapshot, null, 2)}
                </pre>
              </details>
            </>
          )}
          {busy && <p role="status">Creating agent…</p>}
          {fileError && <p role="alert">{fileError}</p>}
        </div>
      )}
    </Dialog>
  );
}
