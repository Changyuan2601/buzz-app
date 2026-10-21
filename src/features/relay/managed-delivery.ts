export type ManagedRecipient = Readonly<{ channelId: string; agentId: string }>;
export type ManagedDelivery = Readonly<{
  version: 1;
  operationKey?: string;
  collection?: string;
  artifactConfirmed?: boolean;
  submittedAt?: number;
  recipient?: ManagedRecipient;
  round: number;
  attempts: number;
  relayAccepted: boolean;
  agentReceived: boolean;
  nextAttemptAt: number;
  receiptDeadline: number;
  error?: "send" | "receipt" | "receipt-save" | "artifact-save" | undefined;
}>;
export type DeliveryState = Readonly<{
  operationId: string;
  eventId: string;
  phase: "sending" | "received" | "failed";
  relayAccepted: boolean;
  agentReceived: boolean;
  error?: string;
}>;
export const MANAGED_RECEIPT_MS = 30_000;
export const MANAGED_MAX_ATTEMPTS = 3;
type ManagedHost = {
  owner(owned: boolean): Promise<void>;
  receive(
    channelId: string,
    agentId: string,
    messageIds: readonly string[],
  ): Promise<void>;
};
const hosts = new Map<string, ManagedHost>();
const owners = new Set<string>();
const locks = new Map<string, AbortController>();
const transitions = new Map<string, Promise<void>>();
function transition(scope: string, work: () => Promise<void>) {
  const next = (transitions.get(scope) ?? Promise.resolve())
    .catch(() => {})
    .then(work);
  transitions.set(scope, next);
  return next;
}
export function registerManagedDelivery(scope: string, host: ManagedHost) {
  const prior = hosts.get(scope);
  hosts.set(scope, host);
  if (
    typeof navigator !== "undefined" &&
    navigator.locks &&
    !locks.has(scope)
  ) {
    const lifetime = new AbortController();
    locks.set(scope, lifetime);
    void navigator.locks
      .request(
        `buzz-outbox-owner:${scope}`,
        { mode: "exclusive", signal: lifetime.signal },
        async () => {
          await ownManagedDelivery(scope, true);
          try {
            await new Promise<void>((resolve) => {
              if (lifetime.signal.aborted) resolve();
              else
                lifetime.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
          } finally {
            await ownManagedDelivery(scope, false);
          }
        },
      )
      .catch((error) => {
        if (!lifetime.signal.aborted)
          console.error("Message outbox ownership fails", scope, error);
      });
  }
  void transition(scope, async () => {
    await prior?.owner(false);
    if (hosts.get(scope) === host && owners.has(scope)) await host.owner(true);
  }).catch((error) =>
    console.error("Managed delivery owner fails", scope, error),
  );
  return () => {
    if (hosts.get(scope) === host) {
      hosts.delete(scope);
      locks.get(scope)?.abort();
      locks.delete(scope);
    }
    void transition(scope, () => host.owner(false)).catch((error) =>
      console.error("Managed delivery release fails", scope, error),
    );
  };
}
export async function ownManagedDelivery(scope: string, owned: boolean) {
  if (owned) owners.add(scope);
  else owners.delete(scope);
  await transition(scope, async () => {
    await hosts.get(scope)?.owner(owners.has(scope));
  });
}
export async function receiveManagedDelivery(
  scope: string,
  channelId: string,
  agentId: string,
  messageIds: readonly string[],
) {
  const host = hosts.get(scope);
  if (!host) throw new Error("Message delivery is unavailable");
  await host.receive(channelId, agentId, messageIds);
}
export function managedDelivery(value: unknown): ManagedDelivery {
  const raw = value as ManagedDelivery | null;
  if (
    raw?.version !== 1 ||
    ![raw.round, raw.attempts, raw.nextAttemptAt, raw.receiptDeadline].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    (raw.operationKey !== undefined &&
      (typeof raw.operationKey !== "string" ||
        !raw.operationKey.length ||
        raw.operationKey.length > 200)) ||
    (raw.collection !== undefined &&
      (typeof raw.collection !== "string" || raw.collection.length > 500)) ||
    (raw.artifactConfirmed !== undefined &&
      typeof raw.artifactConfirmed !== "boolean") ||
    (raw.submittedAt !== undefined &&
      (!Number.isSafeInteger(raw.submittedAt) || raw.submittedAt < 0)) ||
    typeof raw.relayAccepted !== "boolean" ||
    typeof raw.agentReceived !== "boolean" ||
    (raw.error !== undefined &&
      !["send", "receipt", "receipt-save", "artifact-save"].includes(
        raw.error,
      )) ||
    (raw.recipient &&
      (!/^[0-9a-f]{64}$/.test(raw.recipient.agentId) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.recipient.channelId)))
  )
    throw new Error("Invalid managed delivery state");
  return Object.freeze({
    ...raw,
    ...(raw.recipient
      ? { recipient: Object.freeze({ ...raw.recipient }) }
      : {}),
  });
}
/** Acceptance and receipt survive a stale writer from another window. */
export function mergeManagedDelivery(
  old: ManagedDelivery,
  next: ManagedDelivery,
): ManagedDelivery {
  if (JSON.stringify(old.recipient) !== JSON.stringify(next.recipient))
    throw new Error("Managed recipient changed");
  if (
    old.collection !== next.collection ||
    old.operationKey !== next.operationKey ||
    old.submittedAt !== next.submittedAt
  )
    throw new Error("Managed operation identity changed");
  const current = old.round > next.round ? old : next;
  const sameRound = old.round === next.round;
  const error = sameRound
    ? (["artifact-save", "receipt-save", "receipt", "send"] as const).find(
        (error) => old.error === error || next.error === error,
      )
    : current.error;
  const relayAccepted = old.relayAccepted || next.relayAccepted;
  const agentReceived = old.agentReceived || next.agentReceived;
  return {
    ...current,
    relayAccepted,
    agentReceived,
    ...(old.artifactConfirmed !== undefined ||
    next.artifactConfirmed !== undefined
      ? {
          artifactConfirmed:
            old.artifactConfirmed === true || next.artifactConfirmed === true,
        }
      : {}),
    attempts: sameRound
      ? Math.max(old.attempts, next.attempts)
      : current.attempts,
    nextAttemptAt: sameRound
      ? Math.max(old.nextAttemptAt, next.nextAttemptAt)
      : current.nextAttemptAt,
    receiptDeadline: sameRound
      ? Math.max(old.receiptDeadline, next.receiptDeadline)
      : current.receiptDeadline,
    error,
    ...(agentReceived ||
    (!current.recipient &&
      relayAccepted &&
      (error !== "artifact-save" ||
        old.artifactConfirmed ||
        next.artifactConfirmed))
      ? { error: undefined }
      : relayAccepted && error === "send"
        ? { error: undefined }
        : {}),
  };
}
export function deliveryState(
  id: string,
  state: ManagedDelivery,
): DeliveryState {
  const received = state.recipient ? state.agentReceived : state.relayAccepted;
  return {
    operationId: id,
    eventId: id,
    phase: received ? "received" : state.error ? "failed" : "sending",
    relayAccepted: state.relayAccepted,
    agentReceived: state.agentReceived,
    ...(!received && state.error
      ? {
          error:
            state.error === "send"
              ? "Could not send"
              : "Could not confirm delivery",
        }
      : {}),
  };
}
