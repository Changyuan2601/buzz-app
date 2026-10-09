import { MembershipChanged, type MemberAdditionIntent } from "./members";
import type { AgentControl } from "../agents/control";
import type { Delivery, LocalEvents } from "../relay/outbox";

type Addition = Readonly<{
  channelId: string;
  pubkey: string;
  pending: boolean;
  confirmed: boolean;
  error?: string;
  removed?: boolean;
}>;

/** Session-owned continuation and recovery; closing a view never cancels intent. */
export function createMemberAdditions(
  signal: AbortSignal,
  add: (
    channelId: string,
    pubkey: string,
    intent: MemberAdditionIntent,
  ) => Promise<void>,
  start: (
    channelId: string,
    pubkey: string,
    control: AgentControl | undefined,
    retryStart: boolean,
  ) => Promise<void>,
  receipts?: LocalEvents,
) {
  let snapshot: readonly Addition[] = [];
  const listeners = new Set<() => void>();
  const pending = new Map<
    string,
    {
      promise: Promise<void>;
      startAgent: boolean;
      control: AgentControl | undefined;
    }
  >();
  const intents = new Map<string, MemberAdditionIntent>();
  const stopReceipts = trackMemberAdditionReceipts(receipts, () =>
    intents.values(),
  );
  function publish(next: readonly Addition[]) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  signal.addEventListener(
    "abort",
    () => {
      stopReceipts?.();
      intents.clear();
      publish([]);
      listeners.clear();
    },
    { once: true },
  );
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(
      channelId: string,
      pubkey: string,
      control?: AgentControl,
      options: { startAgent?: boolean } = {},
    ): Promise<void> {
      if (signal.aborted)
        return Promise.reject(new Error("The community connection closed."));
      const key = JSON.stringify([channelId, pubkey]);
      const existing = pending.get(key);
      if (existing) {
        if (options.startAgent !== false) {
          existing.startAgent = true;
          existing.control = control ?? existing.control;
        }
        return existing.promise;
      }
      const request = { startAgent: options.startAgent !== false, control };
      const matches = (item: Addition) =>
        item.channelId === channelId && item.pubkey === pubkey;
      const previous = snapshot.find(matches);
      const intent = intents.get(key) ?? {};
      intents.set(key, intent);
      let confirmed = previous?.confirmed ?? false;
      const update = (item?: Addition) => {
        if (!signal.aborted)
          publish([
            ...snapshot.filter((value) => !matches(value)),
            ...(item ? [item] : []),
          ]);
      };
      const operation = Promise.resolve()
        .then(async () => {
          signal.throwIfAborted();
          const retryStart = confirmed;
          if (!confirmed) {
            await add(channelId, pubkey, intent);
            confirmed = true;
          }
          signal.throwIfAborted();
          // Mention sends wake agents through the confirmed outgoing message.
          if (request.startAgent)
            await start(channelId, pubkey, request.control, retryStart);
          update();
        })
        .catch((error: unknown) => {
          update({
            channelId,
            pubkey,
            pending: false,
            confirmed: error instanceof MembershipChanged ? false : confirmed,
            removed: error instanceof MembershipChanged,
            error:
              error instanceof Error
                ? error.message
                : "Could not add this member. Try again.",
          });
          throw error;
        })
        .finally(() => {
          pending.delete(key);
        });
      const entry = Object.assign(request, { promise: operation });
      pending.set(key, entry);
      update({ channelId, pubkey, pending: true, confirmed });
      return operation;
    },
  });
}

/** Only observed failed receipts can become explicit dismissals. Missing accepted
 * or unknown evidence must never authorize a replacement membership write. */
export function trackMemberAdditionReceipts(
  receipts: LocalEvents | undefined,
  intents: () => Iterable<MemberAdditionIntent>,
) {
  const deliveries = new WeakMap<MemberAdditionIntent, Delivery>();
  return receipts?.subscribe(() => {
    const current = new Map(
      receipts.snapshot().map((item) => [item.event.id, item.delivery]),
    );
    for (const intent of intents()) {
      if (!intent.id) continue;
      const delivery = current.get(intent.id);
      // Failed outstanding records are removed only by durable explicit dismissal.
      // Completed echoes can be evicted, so their absence never permits a new send.
      if (
        !delivery &&
        !intent.confirmed &&
        deliveries.get(intent) === "failed"
      ) {
        deliveries.delete(intent);
        intent.dismissed = true;
      } else if (delivery) deliveries.set(intent, delivery);
    }
  });
}
