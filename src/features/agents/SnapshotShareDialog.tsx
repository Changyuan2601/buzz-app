import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import { RecipientPicker } from "../direct-messages/RecipientPicker";
import type { Recipient } from "../direct-messages/usePeople";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import {
  sendSnapshot,
  type EncodedSnapshot,
  type SnapshotSendState,
} from "./snapshot-send";

import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  recoverSnapshot,
  snapshotRecoveryKey,
  snapshotRecoveryValue,
  type MemoryLevel,
} from "./snapshot-recovery";
import type { OutgoingEvent } from "../relay/outbox";

const emptyOperations: readonly OutgoingEvent[] = [];
const emptySnapshot = () => emptyOperations;
const noSubscribe = () => () => {};
type Props = {
  session: RelaySession;
  displayName: string;
  sourceId: string;
  hasMemoryOptions: boolean;
  snapshotKind: "agent" | "team";
  excludedPubkeys: readonly string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  encodeSnapshot(
    level: MemoryLevel,
    signal?: AbortSignal,
  ): Promise<EncodedSnapshot>;
  copyLink(
    snapshot: Promise<EncodedSnapshot>,
    signal: AbortSignal,
  ): Promise<void>;
  onExport(): void;
  beforeShare?: ReactNode;
  catalogControls?: ReactNode;
  actionsDisabled?: boolean;
  preventClose?: boolean;
  catalog: {
    shared: boolean;
    description: string;
    setShared(shared: boolean): Promise<void>;
  };
};

/** Encoding, clipboard/upload, export and catalog policy stay with their owners. */
export function SnapshotShareDialog(props: Props) {
  // Fresh openings are config-only; outstanding journaled sends resume exact intent.
  return props.open ? (
    <ShareContents key={`${props.snapshotKind}:${props.sourceId}`} {...props} />
  ) : null;
}

function ShareContents({
  session,
  displayName,
  sourceId,
  hasMemoryOptions,
  snapshotKind,
  excludedPubkeys,
  onOpenChange,
  encodeSnapshot,
  copyLink,
  onExport,
  catalog,
  beforeShare,
  catalogControls,
  actionsDisabled = false,
  preventClose = false,
}: Props) {
  const notify = useToastNotification();
  const outbox = session.outbox;
  const recoveryKey = snapshotRecoveryKey(snapshotKind, sourceId);
  useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const [ready, setReady] = useState(false);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [level, setLevel] = useState<MemoryLevel>("none");
  const [send, setSend] = useState<SnapshotSendState>({ phase: "idle" });
  const [copy, setCopy] = useState<"idle" | "copying" | "copied">("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{
    action: "send" | "copy";
    level: Exclude<MemoryLevel, "none">;
  } | null>(null);
  const operation = useRef<AbortController | null>(null);
  const encoded = useRef(new Map<MemoryLevel, Promise<EncodedSnapshot>>());
  const sending = ["preparing", "uploading", "sending"].includes(send.phase);
  const busy = sending || copy === "copying" || pending || preventClose;
  const failed =
    !!send.receipt &&
    session.directMessages.delivery(send.receipt.eventId) === "failed";
  const locked = !ready || busy || (!!send.receipt && !failed);
  const item = snapshotKind === "agent" ? "Agent" : "Team";
  const excluded = [
    ...excludedPubkeys,
    ...(session.relayAuthor ? [session.relayAuthor] : []),
  ];

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!outbox) throw new Error("Sharing recovery is unavailable.");
        await outbox.ready();
        const saved = recoverSnapshot(outbox.snapshot(), recoveryKey);
        if (!active) return;
        if (saved) {
          setRecipients(saved.people);
          setLevel(saved.level);
          setSend({ phase: "error", receipt: saved.receipt });
          const delivery = session.directMessages.delivery(
            saved.receipt.eventId,
          );
          if (delivery === "accepted" || delivery === "seen") {
            try {
              await outbox.acknowledge(saved.receipt.eventId);
              if (!active) return;
              setRecipients([]);
              setLevel("none");
              setSend({ phase: "idle" });
            } catch {
              if (!active) return;
              setError(`Couldn’t send ${snapshotKind}. Try again.`);
            }
          }
        }
        setReady(true);
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not restore sharing.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [outbox, recoveryKey, session.directMessages, snapshotKind]);

  useEffect(() => {
    if (copy !== "copied") return;
    const timer = window.setTimeout(() => setCopy("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copy]);

  useEffect(() => {
    const cache = encoded.current;
    return () => {
      operation.current?.abort();
      cache.clear();
    };
  }, []);

  function encode(memory: MemoryLevel, signal: AbortSignal) {
    const cached = encoded.current.get(memory);
    if (cached) return cached;
    const pending = Promise.resolve().then(() =>
      encodeSnapshot(memory, signal),
    );
    encoded.current.set(memory, pending);
    void pending.catch(() => {
      if (encoded.current.get(memory) === pending)
        encoded.current.delete(memory);
    });
    return pending;
  }

  function validateRecipients() {
    if (!send.receipt && recoverSnapshot(outbox?.snapshot() ?? [], recoveryKey))
      throw new Error(
        "Resume the earlier sharing operation before sending another copy.",
      );
    const managed = new Set(
      session.agentChoices
        .snapshot()
        .identities.filter((agent) => agent.managed)
        .map((agent) => agent.pubkey),
    );
    if (
      recipients.some(
        (person) =>
          person.pubkey === session.viewer ||
          excluded.includes(person.pubkey) ||
          ((person.isAgent ||
            session.profiles.snapshot().get(person.pubkey)?.isAgent) &&
            !managed.has(person.pubkey)),
      )
    )
      throw new Error("A selected recipient is no longer available.");
  }

  async function perform(action: "send" | "copy", memory: MemoryLevel) {
    if (operation.current || actionsDisabled) return;
    const controller = new AbortController();
    operation.current = controller;
    setError("");
    let completedReceipt = send.receipt;
    try {
      if (action === "send") {
        const receipt = await sendSnapshot({
          session,
          validateRecipients,
          recovery: {
            key: recoveryKey,
            value: snapshotRecoveryValue(recipients, memory),
          },
          recipients: recipients.map((person) => person.pubkey),
          encode: () => encode(memory, controller.signal),
          signal: controller.signal,
          update: (state) => {
            if (!controller.signal.aborted) setSend(state);
          },
          ...(send.receipt ? { receipt: send.receipt } : {}),
        });
        completedReceipt = receipt;
        await outbox?.acknowledge(receipt.eventId);
        controller.signal.throwIfAborted();
        notify(`Sent a copy of ${displayName}`, "success");
        onOpenChange(false);
      } else {
        setCopy("copying");
        await copyLink(encode(memory, controller.signal), controller.signal);
        controller.signal.throwIfAborted();
        setCopy("copied");
      }
    } catch {
      if (!controller.signal.aborted) {
        if (action === "copy") setCopy("idle");
        else if (completedReceipt)
          setSend({ phase: "error", receipt: completedReceipt });
        setError(
          action === "copy"
            ? "Couldn’t copy link. Try again."
            : `Couldn’t send ${snapshotKind}. Try again.`,
        );
      }
      controller.abort();
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  function request(action: "send" | "copy") {
    if (
      !ready ||
      busy ||
      confirmation ||
      (action === "send" && !recipients.length)
    )
      return;
    if (
      hasMemoryOptions &&
      level !== "none" &&
      !(action === "send" && send.receipt)
    ) {
      setConfirmation({ action, level });
    } else void perform(action, hasMemoryOptions ? level : "none");
  }

  async function edit(change: () => void) {
    if (locked || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    try {
      if (send.receipt) {
        if (
          !outbox ||
          session.directMessages.delivery(send.receipt.eventId) !== "failed"
        )
          throw new Error(
            "Confirm the earlier sharing operation before editing.",
          );
        await outbox.dismiss(send.receipt.eventId);
        controller.signal.throwIfAborted();
        setSend({ phase: "idle" });
      }
      change();
      setError("");
      setCopy("idle");
    } catch {
      if (!controller.signal.aborted)
        setError("Couldn’t dismiss the earlier send. Try again.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  async function changeCatalog() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError("");
    try {
      await catalog.setShared(!catalog.shared);
    } catch {
      if (!controller.signal.aborted)
        setError("Couldn’t update catalog. Try again.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  const names = recipients.map((person) => person.name);
  const audience =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

  return (
    <>
      <Dialog
        open
        onOpenChange={onOpenChange}
        preventClose={busy || preventClose}
        title={`Share ${displayName}`}
        description={`Anyone you share this ${snapshotKind} with will receive a copy they can add and use. Changes you make later won’t sync.`}
        actions={
          <Button disabled={busy} onClick={onExport}>
            Export {snapshotKind}
          </Button>
        }
      >
        {beforeShare}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <RecipientPicker
              session={session}
              scope={session.scope}
              selected={recipients}
              initiallyOpen={false}
              disabled={locked || send.phase === "done"}
              excludedPubkeys={excluded}
              onChange={(people) => void edit(() => setRecipients(people))}
            />
          </div>
          {recipients.length > 0 && (
            <Button
              disabled={
                !ready ||
                actionsDisabled ||
                busy ||
                send.phase === "done" ||
                !session.directMessages.available
              }
              onClick={() => request("send")}
            >
              {sending
                ? "Sending…"
                : send.phase === "error" && send.receipt
                  ? "Retry send"
                  : "Send"}
            </Button>
          )}
        </div>
        {send.phase === "error" && send.receipt && !failed && !busy && (
          <p role="status">
            Retry the earlier message to confirm its delivery before editing.
          </p>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-label-sm text-secondary">Share settings</h3>
          {hasMemoryOptions && (
            <div className="flex items-center justify-between gap-3">
              <h4 className="m-0 text-label">What’s included</h4>
              <Select
                label="What to include"
                variant="compact"
                value={level}
                disabled={locked}
                groups={[
                  {
                    label: "",
                    options: [
                      { value: "none", label: `${item} only` },
                      { value: "core", label: `${item} + core memory` },
                      { value: "everything", label: `${item} + all memories` },
                    ],
                  },
                ]}
                onValueChange={(next) => {
                  if (
                    next === "none" ||
                    next === "core" ||
                    next === "everything"
                  ) {
                    void edit(() => setLevel(next));
                  }
                }}
              />
            </div>
          )}
          {hasMemoryOptions && level !== "none" && (
            <p className="m-0 text-body-sm text-secondary">
              Memory is stored as plaintext in the snapshot. Only share it with
              people you trust.
            </p>
          )}
          <div className="flex justify-end">
            <Button
              disabled={!ready || busy || actionsDisabled}
              onClick={() => request("copy")}
            >
              {copy === "copying"
                ? "Copying…"
                : copy === "copied"
                  ? "Copied"
                  : "Copy link"}
            </Button>
          </div>
        </section>
        {catalogControls ?? (
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-label">Share to catalog</h3>
            <p className="m-0 text-body-sm text-secondary">
              {catalog.description}
            </p>
            <Switch
              aria-label="Share to catalog"
              checked={catalog.shared}
              disabled={busy}
              onCheckedChange={() => void changeCatalog()}
            />
          </section>
        )}
        {error && <p role="alert">{error}</p>}
      </Dialog>
      {confirmation && (
        <AlertDialog
          title="Share memories?"
          description={`This ${snapshotKind} includes plaintext ${confirmation.level === "core" ? "core memory" : "all memories"}. ${confirmation.action === "copy" ? "Anyone with the link can view it." : `${audience}—and anyone with the file link—can view it.`} Only share with people you trust.`}
          onClose={() => setConfirmation(null)}
          actions={
            <>
              <Button onClick={() => setConfirmation(null)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  const pending = confirmation;
                  setConfirmation(null);
                  void perform(pending.action, pending.level);
                }}
              >
                {confirmation.action === "copy" ? "Copy link" : "Send"}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
