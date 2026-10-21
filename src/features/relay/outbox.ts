import { ARTIFACT_MAX_EVENT_BYTES } from "../agents/agent-config-artifacts";
import { isWorkflowOperation } from "../workflows/protocol";
import {
  managedDelivery,
  mergeManagedDelivery,
  deliveryState,
  MANAGED_MAX_ATTEMPTS,
  MANAGED_RECEIPT_MS,
  type ManagedDelivery,
  type ManagedRecipient,
} from "./managed-delivery";
import { yieldToHost } from "./yield";
import { getEventHash, type EventTemplate } from "nostr-tools";
import { eventDto, type EventData, type RelayEvent } from "./events";
import type { RelayWriter } from "./transport";
import { ByteLru, byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import { channelRowKind } from "./membership";
import { MessageClock } from "./message-order";
import {
  bytes,
  isCatalogKind,
  MAX_CONTENT_BYTES,
  MAX_EVENT_BYTES,
} from "../agents/catalog-envelope";

export type Delivery = "sending" | "accepted" | "unknown" | "failed" | "seen";
/** Durable, caller-owned recovery state committed with the operation. */
export type OutboxRecovery = Readonly<{ key: string; value: string }>;
function recoveryValue(value: OutboxRecovery | undefined) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value.key !== "string" ||
    !value.key.length ||
    value.key.length > 200 ||
    typeof value.value !== "string" ||
    byteSize(value) > 64 * 1024
  )
    throw new Error("Invalid outbox recovery state");
  return Object.freeze({ key: value.key, value: value.value });
}
export type OutgoingEvent = Readonly<{
  event: EventData;
  signed?: RelayEvent;
  recovery?: OutboxRecovery | undefined;
  /** Caller verified the operation’s domain outcome, not merely delivery. */
  acknowledged?: true;
  /** A caller-scoped admission requires renewed live eligibility for retry. */
  guarded?: boolean;
  managed?: ManagedDelivery;
  delivery: Delivery;
  error?: string | undefined;
  /** The relay refused the last attempt, rather than it failing on this
   * device, being asked to wait, or going unanswered. */
  refused?: true | undefined;
}>;
export interface Outbox {
  /** Outstanding operations only. Confirmed events live in the session's retained data. */
  snapshot(): readonly OutgoingEvent[];
  subscribe(listener: () => void): () => void;
  /** Capture fresh send intent synchronously; returned work runs once after
   * receipt/verified echo, never history hydration. It cannot affect delivery. */
  observeSend(listener: SendObserver): () => void;
  supports(kind: number): boolean;
  ready(): Promise<void>;
  send(
    input: Pick<EventTemplate, "kind" | "content" | "tags"> & {
      /** NIP-AP: created_at of the newest observed head this event replaces. */
      supersedes?: number;
    },
    recovery?: OutboxRecovery,
    active?: () => boolean,
    managed?: Readonly<{ recipient?: ManagedRecipient }>,
  ): string;
  /** Attach caller-owned recovery to an existing receipt before resuming it. */
  recover(id: string, recovery: OutboxRecovery): Promise<void>;
  acknowledge(id: string): Promise<void>;
  retry(id: string, active?: () => boolean): void;
  dismiss(id: string): Promise<void>;
  /** Durable explicit dismissal, with delivery evidence at removal. */
  observeDismiss(listener: (item: OutgoingEvent) => void): () => void;
}
type SendObserver = (
  event: EventData,
  signal: AbortSignal,
) => ((pending: readonly EventData[]) => void) | undefined;
export type LocalEvents = Pick<Outbox, "snapshot" | "subscribe">;
export interface OutboxStorage {
  subscribe?(listener: () => void): () => void;
  close?(): void;
  load(options?: {
    refresh: true;
  }): readonly OutgoingEvent[] | Promise<readonly OutgoingEvent[]>;
  save(operations: readonly OutgoingEvent[]): void | Promise<void>;
}
export class PublishRejected extends Error {
  /** The relay's own refusal text, when it sent one; `message` stays the
   * display summary. Bounded by the transport that read it. */
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Proven not delivered, but not refused: the request never left this
 * device, or the relay asked it to wait. Retrying may succeed. */
export class PublishNotSent extends PublishRejected {}

export { browserOutboxStorage } from "./outbox-storage";
const abortError = () => new DOMException("Relay session closed", "AbortError");
const MAX_PENDING = 256;
const MAX_CONFIRMED = 2048;

/** One journal owns pending delivery and bounded confirmed retention. Views receive one change stream. */
export function createOutbox(
  viewer: string,
  writer: RelayWriter,
  storage: OutboxStorage,
  {
    timeoutMs = 10_000,
    onAccepted = (_event: RelayEvent) => {},
    profiling = createRelayProfiler(),
    notifyListener = (listener: () => void) => listener(),
    preparePublish,
    holdPublish,
    needsReceipt = () => false,
    onReceipt = (_event: EventData, _message: string | undefined) => {},
    clock = new MessageClock(),
  }: {
    /** The session's send clock, shared with its rendered views. */
    clock?: MessageClock;
    timeoutMs?: number;
    /** Commands await their receipt even after a verified echo. Never persisted. */
    needsReceipt?: (event: EventData) => boolean;
    onReceipt?: (event: EventData, message: string | undefined) => void;
    onAccepted?: (event: RelayEvent) => void;
    profiling?: RelayProfiler;
    notifyListener?: (listener: () => void) => void;
    /** Read-only pre-dispatch work under the attempt deadline. The returned
     * synchronous check runs with no await between it and publisher entry. */
    preparePublish?: (
      event: RelayEvent,
      signal: AbortSignal,
    ) => Promise<(() => void) | undefined>;
    /** Work a signed event waits for before it publishes, such as its
     * channel's creation. A held event takes no delivery slot, and its
     * deadline starts when the hold ends; a rejected hold fails it. */
    holdPublish?: (event: RelayEvent) => Promise<void> | undefined;
  } = {},
) {
  const awaitsReceipt = needsReceipt;
  // Transient policy for a caller-scoped invitation. Restored writes never auto-replay.
  const admissionGates = new Map<string, () => boolean>();
  const checkAdmission = (id: string) => {
    if (find(id)?.guarded && admissionGates.get(id)?.() !== true)
      throw new DOMException("Channel addition cancelled", "AbortError");
  };
  let snapshot: readonly OutgoingEvent[] = Object.freeze([]);
  let visible: readonly OutgoingEvent[] = snapshot;
  let finalSnapshot: readonly OutgoingEvent[] | undefined;
  let finalVisible: readonly OutgoingEvent[] | undefined;
  const completed = new ByteLru<OutgoingEvent>(MAX_CONFIRMED, 8 * 1024 * 1024);
  const sizes = new WeakMap<OutgoingEvent, number>();
  let pendingBytes = 0;
  const listeners = new Set<() => void>();
  const localListeners = new Set<() => void>();
  const dismissListeners = new Set<(item: OutgoingEvent) => void>();
  /** One record per queued or active delivery. Its deadline starts at enqueue; a
   * controller exists only while the attempt is signing or publishing. */
  type Attempt = {
    expiresAt: number;
    /** A failed retry cannot disprove an earlier dispatched/accepted attempt. */
    previousDelivery: Delivery;
    timer: ReturnType<typeof setTimeout>;
    intent?: Promise<void>;
    controller?: AbortController;
    /** Waiting on `holdPublish`, or for a slot after it, without using one. */
    held?: true;
  };
  const attempts = new Map<string, Attempt>();
  const deliveries = new Map<Promise<void>, string>();
  const dismissing = new Map<string, Promise<void>>();
  const lifetime = new AbortController();
  const sendListeners = new Set<SendObserver>();
  const deliveryWork = new Map<
    string,
    {
      event: EventData;
      work: ((pending: readonly EventData[]) => void)[];
    }
  >();
  const captureSend = (event: EventData) => {
    const work: ((pending: readonly EventData[]) => void)[] = [];
    for (const listener of sendListeners) {
      try {
        const run = listener(event, lifetime.signal);
        if (run) work.push(run);
      } catch {
        /* Independent observer. */
      }
    }
    if (work.length) deliveryWork.set(event.id, { event, work });
  };
  const delivered = (event: RelayEvent) => {
    const work = deliveryWork.get(event.id)?.work;
    const pending = [...deliveryWork.values()].map((item) => item.event);
    deliveryWork.delete(event.id);
    for (const run of work ?? []) {
      // Execution/UI observers must never change message delivery evidence.
      try {
        run(pending);
      } catch {
        /* Observer owns its error presentation. */
      }
    }
  };
  const inflight = () =>
    [...attempts.values()].filter(
      (attempt) => attempt.controller && !attempt.held,
    ).length;
  /** Attempts whose hold ended, waiting for a free slot. */
  const slotWaiters = new Set<() => void>();
  function nextSlot() {
    return new Promise<void>((resolve) => slotWaiters.add(resolve));
  }
  /** Offers free slots to released holds before queued deliveries; each
   * released hold pumps again when it ends. */
  function pumpDeliveries() {
    if (closed) return;
    if (slotWaiters.size) {
      for (const resolve of [...slotWaiters]) {
        slotWaiters.delete(resolve);
        resolve();
      }
      return;
    }
    for (const queued of snapshot)
      if (queued.delivery === "sending") void deliver(queued.event.id);
  }
  let closed = false;
  let confirmedInvalidated = false;
  let confirmedKeep: ((event: EventData) => boolean) | undefined;
  let storageError: string | undefined;
  let hydrated = false;
  const unsavedManaged = new Set<string>();
  let managedOwner = false;
  let managedTimer: ReturnType<typeof setTimeout> | undefined;
  let durable = Promise.resolve();
  const notify = () => {
    pendingBytes = snapshot.reduce(
      (sum, item) => {
        let size = sizes.get(item);
        if (size === undefined) {
          size = byteSize(item);
          sizes.set(item, size);
        }
        return sum + size;
      },
      2 + Math.max(0, snapshot.length - 1),
    );
    visible = Object.freeze([
      ...completed.entries().map(([, item]) => item),
      ...snapshot,
    ]);
    for (const listener of localListeners) notifyListener(listener);
    for (const listener of listeners) notifyListener(listener);
  };
  const persist = (
    id: string,
    action?: "acknowledge" | "dismiss" | "receipt",
  ) => {
    const queued = profiling.start("outbox.queue", id);
    const work = durable
      .catch(() => {})
      .then(() => ready)
      .then(() => {
        if (storageError) {
          queued("error");
          throw new Error(storageError);
        }
        queued();
        // Hydration may have added restored intent while this commit waited.
        // Commit current state so no intermediate transaction erases that intent.
        const records =
          action === "dismiss"
            ? visible.filter((item) => item.event.id !== id)
            : action === "receipt"
              ? visible.map((item) =>
                  item.event.id === id && item.managed
                    ? {
                        ...item,
                        managed: {
                          ...item.managed,
                          agentReceived: true,
                          error: undefined,
                        },
                      }
                    : item,
                )
              : action === "acknowledge"
                ? visible.map((item) =>
                    item.event.id === id
                      ? {
                          ...item,
                          recovery: undefined,
                          acknowledged: true as const,
                        }
                      : item,
                  )
                : visible;
        const bytes =
          action === "dismiss"
            ? byteSize(snapshot.filter((item) => item.event.id !== id))
            : pendingBytes;
        return profiling.measureAsync("outbox.persist", id, async () => {
          if (bytes > 2 * 1024 * 1024)
            throw new Error("Outbox storage is full");
          await storage.save(records);
          for (const item of records) unsavedManaged.delete(item.event.id);
          if (action === "receipt") {
            const current = find(id);
            if (current?.managed)
              replace({
                ...current,
                managed: {
                  ...current.managed,
                  agentReceived: true,
                  error: undefined,
                },
              });
          }
          if (action === "dismiss") {
            // Commit removal inside the serialized write, before a later save
            // can capture state. Failed storage never exposes a temporary absence.
            const dismissed = snapshot.find((item) => item.event.id === id);
            deliveryWork.delete(id);
            completed.delete(id);
            snapshot = Object.freeze(
              snapshot.filter((item) => item.event.id !== id),
            );
            notify();
            if (dismissed)
              for (const listener of dismissListeners)
                notifyListener(() => listener(dismissed));
          }
          // Release recovery only after its removal is durable, before the next
          // queued save can run. Preserve delivery evidence received during I/O.
          if (action === "acknowledge") {
            const current = visible.find((item) => item.event.id === id);
            if (current) {
              const cleared = {
                ...current,
                recovery: undefined,
                acknowledged: true as const,
              };
              if (
                (current.delivery === "seen" || current.event.kind === 9000) &&
                !attempts.has(id)
              ) {
                completed.set(id, cleared);
                snapshot = Object.freeze(
                  snapshot.filter((item) => item.event.id !== id),
                );
                notify();
              } else replace(cleared);
            }
          }
        });
      });
    durable = work;
    return work;
  };
  const find = (id: string) => snapshot.find((item) => item.event.id === id);
  function replace(item: OutgoingEvent) {
    snapshot = Object.freeze(
      snapshot.map((old) =>
        old.event.id === item.event.id ? Object.freeze(item) : old,
      ),
    );
    notify();
  }
  function saveStatus(item: OutgoingEvent) {
    replace(item);
    void persist(item.event.id).catch(() => {
      /* Durable intent restores as unknown. */
    });
    if (item.managed) wakeManaged();
  }
  const managedDone = (state: ManagedDelivery) =>
    state.relayAccepted && (!state.recipient || state.agentReceived);
  function refreshManaged() {
    const work = durable
      .catch(() => {})
      .then(() => ready)
      .then(async () => {
        if (closed) return;
        const beforeLoad = new Map(
          snapshot.map((item) => [item.event.id, item]),
        );
        const records = await storage.load({ refresh: true });
        validateSaved(records);
        const incoming = new Map(
          records
            .filter((item) => item.managed)
            .map((item) => [item.event.id, decode(item)]),
        );
        const next = new Map(snapshot.map((item) => [item.event.id, item]));
        const before = JSON.stringify(visible);
        for (const [id, item] of incoming) {
          const prior = next.get(id) ?? completed.peek(id);
          const managed =
            prior?.managed && item.managed
              ? mergeManagedDelivery(prior.managed, item.managed)
              : item.managed;
          const merged = {
            ...item,
            ...(attempts.has(id) && prior
              ? { delivery: prior.delivery, error: prior.error }
              : {}),
            ...(managed ? { managed } : {}),
          };
          if (managed && managedDone(managed) && !attempts.has(id)) {
            completed.set(id, merged);
            next.delete(id);
          } else {
            next.set(id, merged);
            completed.delete(id);
          }
        }
        for (const [id, item] of next)
          if (
            item.managed &&
            !incoming.has(id) &&
            !attempts.has(id) &&
            !unsavedManaged.has(id) &&
            beforeLoad.get(id) === item
          )
            next.delete(id);
        snapshot = Object.freeze([...next.values()]);
        if (
          before !==
          JSON.stringify([
            ...completed.entries().map(([, item]) => item),
            ...snapshot,
          ])
        )
          notify();
      });
    durable = work;
    return work;
  }
  function wakeManaged(delay = 0) {
    if (closed || !managedOwner) return;
    clearTimeout(managedTimer);
    managedTimer = setTimeout(() => {
      managedTimer = undefined;
      void pumpManaged().catch(() => {});
    }, delay);
  }
  async function pumpManaged() {
    if (closed || !managedOwner) return;
    await refreshManaged();
    if (closed || !managedOwner) return;
    let delay = Infinity;
    for (const item of [...snapshot]) {
      const state = item.managed;
      const id = item.event.id;
      if (!state || attempts.has(id)) continue;
      if (managedDone(state)) {
        completed.set(id, item);
        snapshot = Object.freeze(snapshot.filter((row) => row.event.id !== id));
        notify();
        await persist(id);
        continue;
      }
      if (state.error) continue;
      if (state.relayAccepted) {
        if (state.receiptDeadline <= Date.now())
          saveStatus({ ...item, managed: { ...state, error: "receipt" } });
        else delay = Math.min(delay, state.receiptDeadline - Date.now());
      } else if (item.refused || state.attempts >= MANAGED_MAX_ATTEMPTS) {
        saveStatus({ ...item, managed: { ...state, error: "send" } });
      } else if (state.nextAttemptAt > Date.now())
        delay = Math.min(delay, state.nextAttemptAt - Date.now());
      else {
        replace({ ...item, delivery: "sending", error: undefined });
        schedule(id, undefined, item.delivery);
      }
    }
    if (Number.isFinite(delay)) wakeManaged(delay);
  }
  function validateSaved(loaded: readonly OutgoingEvent[]) {
    if (
      !Array.isArray(loaded) ||
      loaded.length > MAX_PENDING + MAX_CONFIRMED ||
      byteSize(loaded) > 10 * 1024 * 1024
    )
      throw new Error("Saved outbox exceeds its budget");
  }
  function decode(item: OutgoingEvent): OutgoingEvent {
    const signed = item.signed
      ? eventDto(JSON.parse(JSON.stringify(item.signed)))
      : undefined;
    const event = signed ?? item.event;
    if (!event || event.pubkey !== viewer || getEventHash(event) !== event.id)
      throw new Error("Saved outbox event is invalid");
    return Object.freeze({
      event: Object.freeze({
        ...event,
        tags: Object.freeze(
          event.tags.map((tag: string[]) => Object.freeze([...tag])),
        ) as unknown as string[][],
      }),
      ...(signed ? { signed } : {}),
      ...(item.recovery ? { recovery: recoveryValue(item.recovery) } : {}),
      ...(item.acknowledged === true ? { acknowledged: true as const } : {}),
      ...(item.guarded ? { guarded: true } : {}),
      ...(item.managed ? { managed: managedDelivery(item.managed) } : {}),
      ...(item.managed && item.refused ? { refused: true as const } : {}),
      delivery: item.managed?.relayAccepted
        ? "accepted"
        : item.delivery === "seen" && signed
          ? "seen"
          : item.delivery === "failed"
            ? "failed"
            : "unknown",
      ...(item.error ? { error: item.error } : {}),
    });
  }
  function restore(restored: readonly OutgoingEvent[]) {
    const pending = restored.filter(
      (item) =>
        (item.managed
          ? !managedDone(item.managed)
          : !(item.event.kind === 9000 && item.acknowledged) &&
            item.delivery !== "seen") ||
        !!item.recovery ||
        (!!item.managed && !managedDone(item.managed)),
    );
    if (pending.length > MAX_PENDING)
      throw new Error("Saved pending outbox exceeds its budget");
    for (const item of restored)
      if (
        ((!!item.managed && managedDone(item.managed)) ||
          (item.event.kind === 9000 && item.acknowledged) ||
          item.delivery === "seen") &&
        !item.recovery &&
        (!item.managed || managedDone(item.managed)) &&
        (!confirmedInvalidated ||
          (item.event.kind === 9007 && confirmedKeep?.(item.event)))
      )
        completed.set(item.event.id, item);
    snapshot = Object.freeze([...pending, ...snapshot]);
    notify();
  }
  const loadedTiming = profiling.start("outbox.load", "journal");
  let ready: Promise<void>;
  try {
    const loaded = storage.load();
    if (loaded instanceof Promise)
      ready = loaded.then(async (records) => {
        validateSaved(records);
        const decoded: OutgoingEvent[] = [];
        for (let offset = 0; offset < records.length; offset += 12) {
          decoded.push(...records.slice(offset, offset + 12).map(decode));
          if (offset + 12 < records.length) await yieldToHost();
        }
        restore(decoded);
      });
    else {
      validateSaved(loaded);
      restore(loaded.map(decode));
      ready = Promise.resolve();
    }
  } catch (error) {
    ready = Promise.reject(error);
  }
  ready = ready.then(
    () => {
      hydrated = true;
      loadedTiming();
    },
    (error) => {
      loadedTiming("error");
      storageError = `Could not load the outbox: ${String(error)}`;
    },
  );

  function expire(id: string) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    const error = new Error("Delivery timed out; check or retry this message");
    if (attempt.controller) attempt.controller.abort(error);
    else {
      clearTimeout(attempt.timer);
      attempts.delete(id);
      const item = find(id);
      if (!closed && item) {
        if (awaitsReceipt(item.event)) onReceipt(item.event, undefined);
        saveStatus({
          ...item,
          delivery: failedDelivery(attempt),
          error: error.message,
        });
      }
    }
  }
  function failedDelivery(attempt: Attempt): Delivery {
    return attempt.previousDelivery === "unknown" ||
      attempt.previousDelivery === "accepted" ||
      attempt.previousDelivery === "seen"
      ? attempt.previousDelivery
      : "failed";
  }
  function schedule(
    id: string,
    intent?: Promise<void>,
    previousDelivery: Delivery = "failed",
  ) {
    if (closed || attempts.has(id)) return;
    const item = find(id);
    if (item?.managed) {
      if (
        !managedOwner ||
        item.managed.relayAccepted ||
        item.managed.attempts >= MANAGED_MAX_ATTEMPTS ||
        item.managed.error
      )
        return;
      replace({
        ...item,
        managed: {
          ...item.managed,
          attempts: item.managed.attempts + 1,
          nextAttemptAt: Date.now() + 1000 * 2 ** item.managed.attempts,
        },
      });
    }
    attempts.set(id, {
      expiresAt: Date.now() + timeoutMs,
      previousDelivery,
      timer: setTimeout(() => expire(id), timeoutMs),
      ...(intent ? { intent } : {}),
    });
    void deliver(id);
  }
  function deliver(id: string) {
    const work = deliverAttempt(id);
    deliveries.set(work, id);
    void work.finally(() => deliveries.delete(work));
    return work;
  }
  async function deliverAttempt(id: string) {
    const attempt = attempts.get(id);
    if (closed || !attempt || attempt.controller || inflight() >= 3) return;
    if (!find(id) || (find(id)?.managed && !managedOwner)) return;
    if (Date.now() >= attempt.expiresAt) {
      expire(id);
      return;
    }
    const controller = new AbortController();
    attempt.controller = controller;
    const signal = controller.signal;
    let publishing = false;
    const total = profiling.start("send.delivery", id);
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? abortError()),
        { once: true },
      ),
    );
    try {
      await Promise.race([
        attempt.intent ??
          ready.then(() => {
            if (storageError) throw new Error(storageError);
            return persist(id);
          }),
        aborted,
      ]);
      if (storageError) throw new Error(storageError);
      const initial = find(id);
      if (!initial || closed || signal.aborted) return;
      checkAdmission(id);
      const signedResult =
        initial.signed ??
        (await profiling.measureAsync("send.sign", id, () =>
          Promise.race([writer.sign(initial.event, signal), aborted]),
        ));
      const signed = profiling.measure("send.verify", id, () =>
        eventDto(signedResult),
      );
      if (closed || signal.aborted) throw abortError();
      if (signed.id !== id || signed.pubkey !== viewer)
        throw new Error("Signer changed the outgoing event");
      const current = find(id);
      if (!current) return; // A verified echo already completed delivery.
      replace({ ...current, signed });
      await Promise.race([persist(id), aborted]);
      if (closed || signal.aborted || !find(id)) return;
      const hold = holdPublish?.(signed);
      if (hold) {
        attempt.held = true;
        clearTimeout(attempt.timer);
        pumpDeliveries();
        await Promise.race([hold, aborted]);
        attempt.expiresAt = Date.now() + timeoutMs;
        attempt.timer = setTimeout(() => expire(id), timeoutMs);
        while (inflight() >= 3) await Promise.race([nextSlot(), aborted]);
        delete attempt.held;
        if (closed || signal.aborted || !find(id)) return;
      }
      const check = preparePublish
        ? await profiling.measureAsync("send.prepare", id, () =>
            Promise.race([preparePublish(signed, signal), aborted]),
          )
        : undefined;
      // Preparation cannot make delivery uncertain. Only entering the actual
      // transport publisher crosses that boundary, including for signed retries.
      if (closed || !find(id)) return;
      signal.throwIfAborted();
      const receipt = await profiling.measureAsync("send.publish", id, () => {
        check?.();
        checkAdmission(id);
        publishing = true;
        return Promise.race([writer.publish(signed, signal), aborted]);
      });
      if (closed || signal.aborted) return;
      if (awaitsReceipt(signed))
        onReceipt(signed, typeof receipt === "string" ? receipt : undefined);
      const latest = find(id);
      if (latest)
        saveStatus({
          ...latest,
          ...(latest.managed
            ? {
                managed: {
                  ...latest.managed,
                  relayAccepted: true,
                  receiptDeadline:
                    latest.managed.receiptDeadline ||
                    Date.now() + MANAGED_RECEIPT_MS,
                  error: undefined,
                },
              }
            : {}),
          delivery:
            latest.delivery === "seen" || attempt.previousDelivery === "seen"
              ? "seen"
              : "accepted",
          error: undefined,
        });
      delivered(signed);
      onAccepted(signed);
    } catch (error) {
      const latest = find(id);
      // A verified observation ends the attempt even if its HTTP ACK never arrives.
      total(!closed && !latest ? "ok" : "error");
      if (closed) return;
      if (latest && awaitsReceipt(latest.event))
        onReceipt(latest.signed ?? latest.event, undefined);
      const delivery: Delivery | undefined =
        latest &&
        (latest.delivery === "seen" || attempt.previousDelivery === "seen"
          ? "seen"
          : attempt.previousDelivery === "accepted"
            ? "accepted"
            : publishing && !(error instanceof PublishRejected)
              ? "unknown"
              : failedDelivery(attempt));
      if (latest && delivery)
        saveStatus({
          ...latest,
          delivery,
          refused:
            (delivery === "failed" || !!latest.managed) &&
            error instanceof PublishRejected &&
            !(error instanceof PublishNotSent)
              ? true
              : undefined,
          error: awaitsReceipt(latest.event)
            ? publishing && !(error instanceof PublishRejected)
              ? "Workflow delivery could not be confirmed; inspect recent activity before submitting another command."
              : "Workflow command rejected; retain the draft and refresh the saved configuration."
            : `${
                attempt.previousDelivery === "unknown" ||
                attempt.previousDelivery === "accepted"
                  ? error instanceof PublishRejected
                    ? "Retry blocked: "
                    : "Retry failed: "
                  : ""
              }${error instanceof Error ? error.message : String(error)}`,
        });
      if (publishing && latest?.signed && !(error instanceof PublishRejected))
        onAccepted(latest.signed);
    } finally {
      // Keep a failed invitation fenced for an explicit retry in this session.
      if (
        !find(id) ||
        find(id)?.delivery === "accepted" ||
        find(id)?.delivery === "seen"
      ) {
        admissionGates.delete(id);
      }
      total();
      clearTimeout(attempt.timer);
      if (attempts.get(id) === attempt) attempts.delete(id);
      const observed = find(id);
      if (
        !closed &&
        observed &&
        ((observed.event.kind === 9000 && observed.acknowledged) ||
          observed.delivery === "seen") &&
        !observed.recovery &&
        (!observed.managed || managedDone(observed.managed))
      ) {
        completed.set(id, observed);
        snapshot = Object.freeze(
          snapshot.filter((item) => item.event.id !== id),
        );
        notify();
        void persist(id).catch(() => {});
      }
      pumpDeliveries();
      wakeManaged();
    }
  }
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const outbox: Outbox = Object.freeze({
    snapshot: () => finalSnapshot ?? snapshot,
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    observeSend: (listener: SendObserver) => {
      sendListeners.add(listener);
      return () => {
        sendListeners.delete(listener);
      };
    },
    supports: (kind: number) =>
      !closed && (!writer.kinds || writer.kinds.includes(kind)),
    async ready() {
      await ready;
      if (closed) throw abortError();
      if (storageError) throw new Error(storageError);
    },
    async recover(id: string, recovery: OutboxRecovery) {
      await outbox.ready();
      const saved = recoveryValue(recovery);
      if (!saved) throw new Error("Invalid outbox recovery state");
      const item = visible.find((entry) => entry.event.id === id);
      if (!item || dismissing.has(id))
        throw new Error(
          "The original operation is unavailable. Refresh before retrying.",
        );
      if (item.acknowledged) return;
      if (
        (item.recovery &&
          (item.recovery.key !== saved.key ||
            item.recovery.value !== saved.value)) ||
        snapshot.some(
          (entry) => entry.event.id !== id && entry.recovery?.key === saved.key,
        )
      )
        throw new Error("Recover the earlier message before sending another");
      if (!find(id) && snapshot.length >= MAX_PENDING)
        throw new Error(
          "Too many outstanding operations; resolve a pending operation",
        );
      // Protect immediately against dismissal/echo eviction. On save failure keep
      // that protection; a later recovery attempt must persist it again before use.
      const retained = Object.freeze({ ...item, recovery: saved });
      completed.delete(id);
      snapshot = Object.freeze([
        ...snapshot.filter((entry) => entry.event.id !== id),
        retained,
      ]);
      notify();
      await persist(id);
    },
    async acknowledge(id: string) {
      await outbox.ready();
      const item = visible.find((item) => item.event.id === id);
      if (item?.managed && !managedDone(item.managed) && !item.refused)
        return Promise.reject(
          new Error("Resolve managed delivery before removing this message"),
        );
      if (!item?.recovery) return;
      // Member callers verify a fresh signed roster even when the receipt was lost.
      if (
        !(
          item.event.kind === 9000 &&
          item.recovery.key.startsWith("member-add:")
        ) &&
        item.delivery !== "accepted" &&
        item.delivery !== "seen"
      )
        throw new Error("Confirm delivery before completing this message");
      await persist(id, "acknowledge");
    },
    send(
      {
        supersedes,
        ...input
      }: Pick<EventTemplate, "kind" | "content" | "tags"> & {
        supersedes?: number;
      },
      recovery?: OutboxRecovery,
      active?: () => boolean,
      managed?: Readonly<{ recipient?: ManagedRecipient }>,
    ) {
      if (active && !active())
        throw new DOMException("Channel addition cancelled", "AbortError");
      if (closed) throw abortError();
      if (storageError) throw new Error(storageError);
      const savedRecovery = recoveryValue(recovery);
      if (managed && savedRecovery)
        throw new Error(
          "Managed delivery cannot replace another recovery intent",
        );
      if (
        managed?.recipient &&
        (input.kind !== 9 ||
          !input.tags.some(
            ([name, value]) =>
              name === "h" && value === managed.recipient?.channelId,
          ))
      )
        throw new Error("Managed recipient does not match the message");
      if (
        savedRecovery &&
        (!hydrated ||
          snapshot.some((item) => item.recovery?.key === savedRecovery.key))
      )
        throw new Error("Recover the earlier message before sending another");
      if (
        !Number.isInteger(input.kind) ||
        input.kind < 0 ||
        input.kind > 65535 ||
        !outbox.supports(input.kind)
      )
        throw new Error("This relay connection cannot publish that event kind");
      const catalog = isCatalogKind(input.kind);
      if (
        (input.kind === 9 && !input.content.trim()) ||
        // NIP-AP admits larger public definitions than ordinary input.
        (catalog
          ? bytes(input.content) > MAX_CONTENT_BYTES ||
            byteSize(input) > MAX_EVENT_BYTES
          : byteSize(input) >
            (input.kind === 45010
              ? ARTIFACT_MAX_EVENT_BYTES - 512
              : OUTBOX_INPUT_MAX_BYTES))
      )
        throw new Error("Message is empty or too large");
      if (snapshot.length >= MAX_PENDING)
        throw new Error(
          "Too many outstanding operations; resolve or dismiss a pending operation",
        );
      // Rendered messages carry send order within their second; the optimistic
      // row and the signed event share this exact ms and created_at.
      const channelId = channelRowKind(input.kind)
        ? input.tags.find(([name]) => name === "h")?.[1]
        : undefined;
      const ms = channelId ? clock.next(channelId) : Date.now();
      let createdAt = Math.floor(ms / 1000);
      if (input.kind === 40003) {
        if (!hydrated)
          throw new Error("Message history is still loading. Try again.");
        const target = input.tags.find(([name]) => name === "e")?.[1];
        const channel = input.tags.find(([name]) => name === "h")?.[1];
        // Edits use second precision on every client. Preserve retained local
        // submission order without changing the protocol's event-ID tie-break.
        for (const { event } of visible) {
          if (
            target &&
            channel &&
            event.kind === 40003 &&
            event.pubkey === viewer &&
            event.tags.some(([name, id]) => name === "e" && id === target) &&
            event.tags.some(([name, id]) => name === "h" && id === channel)
          )
            createdAt = Math.max(createdAt, event.created_at + 1);
        }
        // Stay well inside the signer's 15-minute clock-skew allowance.
        if (createdAt > Math.floor(ms / 1000) + 60)
          throw new Error(
            "Edits are arriving too quickly or your clock changed. Wait a moment and try again.",
          );
      }
      if (catalog) {
        // NIP-AP: max(now, head + 1) over the observed relay head and this
        // device's retained writes, so a replacement can never lose or tie.
        if (supersedes !== undefined)
          createdAt = Math.max(createdAt, supersedes + 1);
        const d = input.tags.find(([name]) => name === "d")?.[1];
        for (const { event } of visible)
          if (
            event.kind === input.kind &&
            event.pubkey === viewer &&
            event.tags.some(([name, value]) => name === "d" && value === d)
          )
            createdAt = Math.max(createdAt, event.created_at + 1);
        if (createdAt > Math.floor(ms / 1000) + 60)
          throw new Error(
            "Sharing is changing too quickly or your clock changed. Wait a moment and try again.",
          );
      }
      const template = {
        ...input,
        pubkey: viewer,
        created_at: createdAt,
        tags: [
          ...input.tags.map((tag) => [...tag]),
          ["client-id", crypto.randomUUID()],
          ...(channelId ? [["ms", String(ms % 1000)]] : []),
        ],
      };
      const event = Object.freeze({
        ...template,
        tags: Object.freeze(
          template.tags.map((tag) => Object.freeze(tag)),
        ) as unknown as string[][],
        id: getEventHash(template),
      });
      if (managed) unsavedManaged.add(event.id);
      if (active) admissionGates.set(event.id, active);
      captureSend(event);
      profiling.measure("send.local", event.id, () => {
        snapshot = Object.freeze([
          ...snapshot,
          Object.freeze({
            event,
            delivery: "sending" as const,
            ...(savedRecovery ? { recovery: savedRecovery } : {}),
            ...(active ? { guarded: true } : {}),
            ...(managed
              ? {
                  managed: managedDelivery({
                    version: 1,
                    ...managed,
                    round: 0,
                    attempts: 0,
                    relayAccepted: false,
                    agentReceived: false,
                    nextAttemptAt: 0,
                    receiptDeadline: 0,
                  }),
                }
              : {}),
          }),
        ]);
        notify();
      });
      const intent = ready.then(() => {
        if (storageError) throw new Error(storageError);
        return persist(event.id);
      });
      void intent.catch(() => {}); // Delivery reports persistence errors; disposal still saves queued intent.
      schedule(event.id, intent);
      wakeManaged();
      return event.id;
    },
    retry(id: string, active?: () => boolean) {
      const item = find(id);
      if (item?.managed) {
        replace({
          ...item,
          refused: undefined,
          error: undefined,
          managed: {
            ...item.managed,
            round: item.managed.round + 1,
            attempts: 0,
            nextAttemptAt: 0,
            receiptDeadline: Date.now() + MANAGED_RECEIPT_MS,
            error: undefined,
          },
        });
        void persist(id)
          .then(() => wakeManaged())
          .catch(() => {});
        return;
      }
      if (item?.guarded && (active ?? admissionGates.get(id))?.() !== true)
        throw new DOMException("Channel addition cancelled", "AbortError");
      // Workflow recovery is inspect/dismiss only, including restored intents.
      if (
        !closed &&
        item &&
        !(item.event.kind === 9000 && item.acknowledged) &&
        !isWorkflowOperation(item.event) &&
        !attempts.has(id) &&
        !dismissing.has(id)
      ) {
        // A profile retry can reuse an older, unguarded saved invitation.
        // Promote that intent before scheduling so signing and publication honor
        // the renewed caller policy, including after the next hydration.
        if (active) admissionGates.set(id, active);
        if (item.delivery === "failed" || item.delivery === "unknown")
          captureSend(item.event);
        replace({
          ...item,
          ...(active ? { guarded: true } : {}),
          delivery: "sending",
          error: undefined,
          refused: undefined,
        });
        schedule(id, undefined, item.delivery);
      }
    },
    observeDismiss(listener: (item: OutgoingEvent) => void) {
      dismissListeners.add(listener);
      return () => {
        dismissListeners.delete(listener);
      };
    },
    dismiss(id: string) {
      const pending = dismissing.get(id);
      if (pending) return pending;
      if (closed || attempts.has(id)) return Promise.resolve();
      const item = visible.find((item) => item.event.id === id);
      if (item?.managed && !managedDone(item.managed) && !item.refused)
        return Promise.reject(
          new Error("Resolve managed delivery before removing this message"),
        );
      if (item?.recovery && item.delivery !== "failed")
        return Promise.reject(
          new Error(
            item.event.kind === 9000
              ? "Confirm this addition in Members before removing it"
              : "Confirm this message in New message before removing it",
          ),
        );
      const work = persist(id, "dismiss")
        .then(() => {
          admissionGates.delete(id);
        })
        .finally(() => dismissing.delete(id));
      dismissing.set(id, work);
      return work;
    },
  });
  const stopStorage = storage.subscribe?.(() => {
    void refreshManaged()
      .then(() => wakeManaged())
      .catch(() => {});
  });
  return {
    outbox,
    local: Object.freeze({
      snapshot: () => finalVisible ?? visible,
      subscribe: (listener: () => void) => subscribe(localListeners, listener),
    }),
    ready,
    delivery: {
      async get(id: string) {
        await refreshManaged();
        const item = visible.find((item) => item.event.id === id);
        return item?.managed ? deliveryState(id, item.managed) : undefined;
      },
      subscribe: (listener: () => void) => subscribe(localListeners, listener),
      retry: async (id: string) => {
        await refreshManaged();
        outbox.retry(id);
        await persist(id);
      },
      async submit(
        input: Parameters<Outbox["send"]>[0],
        recipient?: ManagedRecipient,
      ) {
        await outbox.ready();
        const id = outbox.send(input, undefined, undefined, {
          ...(recipient ? { recipient } : {}),
        });
        await persist(id);
        return { operationId: id, eventId: id };
      },
    },
    async managedOwner(owned: boolean) {
      managedOwner = owned;
      clearTimeout(managedTimer);
      if (owned) {
        await refreshManaged();
        wakeManaged();
      } else
        for (const [id, attempt] of attempts)
          if (find(id)?.managed) {
            clearTimeout(attempt.timer);
            attempts.delete(id);
            attempt.controller?.abort(abortError());
          }
      if (!owned) {
        await Promise.allSettled(
          [...deliveries]
            .filter(([, id]) => !!find(id)?.managed)
            .map(([work]) => work),
        );
        await durable.catch(() => {});
      }
    },
    async receiveManaged(
      channelId: string,
      agentId: string,
      messageIds: readonly string[],
    ) {
      if (
        messageIds.length > 256 ||
        messageIds.some((id) => !/^[0-9a-f]{64}$/.test(id))
      )
        throw new Error("Invalid message receipt IDs");
      await refreshManaged();
      for (const id of new Set(messageIds)) {
        const item = find(id);
        if (
          !item?.managed ||
          item.managed.recipient?.channelId !== channelId ||
          item.managed.recipient.agentId !== agentId ||
          item.managed.agentReceived
        )
          continue;
        try {
          await persist(id, "receipt");
        } catch (error) {
          replace({
            ...item,
            managed: { ...item.managed, error: "receipt-save" },
          });
          throw error;
        }
      }
      wakeManaged();
    },
    /** Fetched/confirmed evidence is disposable; pending intent is not. A revoke
     * during async hydration fences that old confirmed cache, not its writes. */
    purgeConfirmed(keep: (event: EventData) => boolean) {
      confirmedInvalidated = true;
      confirmedKeep = keep;
      const removed = completed
        .entries()
        .filter(([, item]) => !keep(item.event))
        .map(([id]) => id);
      for (const id of removed) completed.delete(id);
      if (removed.length) notify();
      // Queue behind hydration so a revoke cannot be undone by an old disk load.
      void persist("access-revoked").catch(() => {});
    },
    observe(events: readonly RelayEvent[]) {
      if (closed) return;
      const byId = new Map(events.map((event) => [event.id, event]));
      const confirmed = snapshot.flatMap((item) => {
        const event = byId.get(item.event.id);
        return event ? [event] : [];
      });
      const [first] = confirmed;
      if (!first) return;
      for (const event of confirmed) {
        delivered(event);
        if (
          (awaitsReceipt(event) && attempts.has(event.id)) ||
          find(event.id)?.recovery ||
          find(event.id)?.managed
        ) {
          snapshot = Object.freeze(
            snapshot.map((item) =>
              item.event.id === event.id
                ? Object.freeze({
                    ...item,
                    signed: event,
                    delivery: "seen" as const,
                    ...(item.managed
                      ? {
                          managed: {
                            ...item.managed,
                            relayAccepted: true,
                            receiptDeadline:
                              item.managed.receiptDeadline ||
                              Date.now() + MANAGED_RECEIPT_MS,
                          },
                        }
                      : {}),
                  })
                : item,
            ),
          );
        } else
          completed.set(
            event.id,
            Object.freeze({
              ...find(event.id),
              event,
              signed: event,
              delivery: "seen",
            }),
          );
      }
      for (const item of snapshot)
        if (
          byId.has(item.event.id) &&
          item.managed &&
          managedDone(item.managed)
        )
          completed.set(item.event.id, item);
      snapshot = Object.freeze(
        snapshot.filter(
          (item) =>
            !byId.has(item.event.id) ||
            (awaitsReceipt(item.event) && attempts.has(item.event.id)) ||
            !!item.recovery ||
            (!!item.managed && !managedDone(item.managed)),
        ),
      );
      for (const event of confirmed) {
        if (awaitsReceipt(event) && attempts.has(event.id)) continue;
        const attempt = attempts.get(event.id);
        attempt?.controller?.abort();
        clearTimeout(attempt?.timer);
        attempts.delete(event.id);
      }
      notify();
      void persist(first.id).catch(() => {});
      wakeManaged();
    },
    dispose() {
      if (closed) return;
      finalSnapshot = snapshot;
      finalVisible = visible;
      closed = true;
      stopStorage?.();
      clearTimeout(managedTimer);
      admissionGates.clear();
      lifetime.abort();
      for (const attempt of attempts.values()) {
        attempt.controller?.abort(abortError());
        clearTimeout(attempt.timer);
      }
      attempts.clear();
      listeners.clear();
      localListeners.clear();
      sendListeners.clear();
      dismissListeners.clear();
      deliveryWork.clear();
      void ready
        .then(() => durable)
        .catch(() => {})
        .finally(() => storage.close?.());
    },
  };
}
