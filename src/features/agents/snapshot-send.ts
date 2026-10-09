import type { RelaySession } from "../relay/session";
import type { OutboxRecovery } from "../relay/outbox";
import { snapshotFile } from "./snapshot-file";

export type SnapshotSendPhase =
  | "idle"
  | "preparing"
  | "uploading"
  | "sending"
  | "done"
  | "error";
export type SnapshotSendReceipt = Readonly<{
  channelId: string;
  eventId: string;
}>;
export type SnapshotSendState = Readonly<{
  phase: SnapshotSendPhase;
  receipt?: SnapshotSendReceipt;
  error?: string;
}>;
export type EncodedSnapshot = Readonly<{
  fileBytes: readonly number[];
  fileName: string;
}>;

/** Snapshot definition/import policy belongs to the snapshot owner. Delivery uses the session's existing DM/outbox. */
export async function sendSnapshot({
  session,
  recipients,
  encode,
  signal,
  update,
  receipt,
  validateRecipients,
  recovery,
}: {
  session: Pick<RelaySession, "directMessages" | "attachments" | "messages">;
  recipients: readonly string[];
  encode: () => Promise<EncodedSnapshot>;
  signal: AbortSignal;
  update: (state: SnapshotSendState) => void;
  receipt?: SnapshotSendReceipt;
  validateRecipients?: () => void;
  recovery?: OutboxRecovery;
}): Promise<SnapshotSendReceipt> {
  let current = receipt;
  try {
    signal.throwIfAborted();
    if (
      current &&
      session.directMessages.delivery(current.eventId) === "failed"
    )
      validateRecipients?.();
    if (!current) {
      if (!session.directMessages.available || !session.attachments)
        throw new Error("Sending is unavailable.");
      validateRecipients?.();
      update({ phase: "preparing" });
      const channelId = await session.directMessages.open(recipients, signal);
      signal.throwIfAborted();
      validateRecipients?.();
      const encoded = await encode();
      signal.throwIfAborted();
      validateRecipients?.();
      const file = snapshotFile(encoded);
      update({ phase: "uploading" });
      const attachment = await session.attachments.upload(
        file,
        channelId,
        signal,
      );
      signal.throwIfAborted();
      validateRecipients?.();
      const eventId = session.messages.send(
        channelId,
        "",
        [],
        [attachment],
        recovery,
      );
      current = { channelId, eventId };
    }
    // Store the receipt before awaiting delivery. An uncertain result retries this
    // exact operation, never another encode/upload/message. Cancelling this waiter
    // cannot withdraw an operation already submitted to the durable outbox.
    update({ phase: "sending", receipt: current });
    await session.directMessages.delivered(
      current.eventId,
      current.channelId,
      signal,
    );
    signal.throwIfAborted();
    update({ phase: "done", receipt: current });
    return current;
  } catch (error) {
    update({
      phase: "error",
      ...(current ? { receipt: current } : {}),
      error: error instanceof Error ? error.message : "Send failed.",
    });
    throw error;
  }
}
