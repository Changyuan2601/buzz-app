import type { RelaySession } from "../relay/session";
import type { OutboxRecovery } from "../relay/outbox";
import { followUpMessage } from "./follow-up-message";
import {
  followUpStorage,
  followUpRecovery,
  type FollowUpMessage,
} from "./follow-up-storage";

type Activity = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
type Wait = { agent: string; message?: string; turn?: string; resumed?: true };
type Entry = {
  id: string;
  channelId: string;
  text: string;
  recipients: readonly string[];
  publish(recovery?: OutboxRecovery): string;
  message?: FollowUpMessage;
  restored?: boolean;
  beforeRelease?(): Promise<void>;
  beforePublish?(): void;
  onSend?(id: string): void;
  error?: string;
};
const queues = new WeakMap<RelaySession, ReturnType<typeof createQueue>>();

/** Pending Solo sends survive navigation and, with a message payload, restart. */
export function followUpQueue(session: RelaySession) {
  let queue = queues.get(session);
  if (!queue) {
    queue = createQueue(session);
    queues.set(session, queue);
  }
  return queue;
}

function createQueue(session: RelaySession) {
  let entries: readonly Entry[] = [];
  const storage =
    session.scope && session.viewer
      ? followUpStorage(session.scope)
      : undefined;
  let storageError: string | undefined;
  let sequence = Date.now();
  function restore() {
    if (!storage) return;
    try {
      const saved = storage.load();
      sequence = Math.max(sequence, ...saved.map((entry) => entry.createdAt));
      entries = saved.map(
        (saved) =>
          entries.find((entry) => entry.id === saved.id) ?? {
            ...saved,
            message: saved,
            restored: true,
            ...followUpMessage(session, saved),
          },
      );
      storageError = undefined;
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
  }
  restore();
  const waits = new Map<string, Wait[]>();
  // A resumed request supersedes its old observer turn, which may never emit
  // completion after the old process died. Only fresh local work settles it.
  const resumedRequests = new Set<string>();
  const resumedTurn = (turn: Activity["turns"][number]) =>
    !!turn.requests?.length &&
    turn.requests.every((request) =>
      resumedRequests.has(`${turn.agent}:${request.messageId}`),
    );
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const publishing = new Set<string>();
  const requested = new Map<string, (() => void) | undefined>();
  const acknowledging = new Set<string>();
  let activating = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  function finished(wait: Wait, activity: Activity) {
    if (wait.message) {
      const local = activity.local?.find(
        (row) => row.agent === wait.agent && row.messageId === wait.message,
      );
      if (local)
        return (
          local.state === "done" ||
          local.state === "error" ||
          local.state === "superseded" ||
          local.state === "stopped"
        );
      if (wait.resumed) return false;
      const turns = activity.turns.filter(
        (turn) =>
          turn.agent === wait.agent &&
          turn.requests?.some((request) => request.messageId === wait.message),
      );
      return turns.length > 0 && turns.every((turn) => turn.state === "ended");
    }
    return activity.turns.some(
      (turn) =>
        turn.agent === wait.agent &&
        turn.turnId === wait.turn &&
        (turn.state === "ended" || resumedTurn(turn)),
    );
  }
  function blockers(channelId: string) {
    const activity = session.agentActivity?.snapshot();
    let current = waits.get(channelId) ?? [];
    if (activity) {
      current = current.filter((wait) => !finished(wait, activity));
      const local = (activity.local ?? []).filter(
        (row) => row.channelId === channelId,
      );
      for (const row of local) {
        if (row.state === "working" || row.state === "waiting")
          current.push({ agent: row.agent, message: row.messageId });
      }
      for (const turn of activity.turns) {
        if (
          turn.channelId === channelId &&
          turn.state === "working" &&
          !resumedTurn(turn)
        )
          current.push({ agent: turn.agent, turn: turn.turnId });
      }
    }
    current = [
      ...new Map(current.map((wait) => [JSON.stringify(wait), wait])).values(),
    ];
    if (current.length) waits.set(channelId, current);
    else waits.delete(channelId);
    return (
      current.length > 0 ||
      (session.typing?.snapshot() ?? []).some(
        (entry) =>
          entry.channelId === channelId &&
          !entry.threadRootId &&
          session.agentChoices
            ?.snapshot()
            .identities.some((agent) => agent.pubkey === entry.pubkey),
      ) ||
      (activity?.typing ?? []).some(
        (entry) => entry.channelId === channelId && !entry.threadRootId,
      ) ||
      (!!activity &&
        activity.status !== "listening" &&
        activity.status !== "unavailable")
    );
  }
  function watch() {
    if (stop) return;
    activating = true;
    const unsubscribe = session.agentActivity.subscribe(pump);
    const deactivate = session.agentActivity.activate();
    const offTyping = session.typing?.subscribe(pump);
    const offChoices = session.agentChoices?.subscribe(pump);
    const offChannels = session.channels.subscribeList?.(() => {
      const roster = session.channels.list();
      // The store retains channels on ordinary loading/read failures. Confirmed
      // denial removes them even when list status is error; cached membership
      // alone does not establish revocation.
      const retired = new Set(
        [...waits.keys(), ...entries.map((entry) => entry.channelId)].filter(
          (id) => {
            const channel = roster.channels.find((row) => row.id === id);
            return (
              (!channel &&
                (roster.status === "ready" ||
                  entries.some(
                    (entry) => entry.channelId === id && !entry.restored,
                  ))) ||
              (channel?.readOnly && !channel.cached)
            );
          },
        ),
      );
      if (!retired.size) return;
      for (const entry of entries.filter((entry) =>
        retired.has(entry.channelId),
      ))
        remove(entry.id);
      for (const id of retired) waits.delete(id);
      emit();
      pump();
    });
    const offDismiss = session.outbox?.observeDismiss((item) => {
      if (item.delivery !== "failed") return;
      for (const [channelId, current] of waits) {
        const remaining = current.filter(
          (wait) => wait.message !== item.event.id,
        );
        if (remaining.length) waits.set(channelId, remaining);
        else waits.delete(channelId);
      }
      pump();
    });
    const offRemoval = session.channelLifecycle?.observeRemoval((channelId) => {
      for (const entry of entries.filter(
        (entry) => entry.channelId === channelId,
      ))
        remove(entry.id);
      waits.delete(channelId);
      emit();
      pump();
    });
    const offOutbox = session.outbox?.subscribe(() => {
      reconcileDelivery();
    });
    stop = () => {
      offOutbox?.();
      unsubscribe();
      offTyping?.();
      offChoices?.();
      offChannels?.();
      offDismiss?.();
      offRemoval?.();
      deactivate();
    };
    activating = false;
  }
  function sent(entry: Omit<Entry, "id">, recovery?: OutboxRecovery) {
    const id = entry.publish(recovery);
    // Include the gap between publication and the first working signal.
    waits.set(entry.channelId, [
      ...(waits.get(entry.channelId) ?? []),
      ...entry.recipients.map((agent) => ({ agent, message: id })),
    ]);
    watch();
    return id;
  }
  // Recovery metadata bridges the durable queue to the durable Outbox. Keep it
  // until the queue record is removed, then release accepted delivery receipts.
  function reconcileDelivery() {
    if (!storage || !session.outbox) return;
    try {
      for (const item of session.outbox.snapshot()) {
        if (
          !item.recovery?.key.startsWith("follow-up:") ||
          item.acknowledged ||
          (item.delivery !== "accepted" && item.delivery !== "seen") ||
          storage.has(item.recovery.value) ||
          acknowledging.has(item.event.id)
        )
          continue;
        acknowledging.add(item.event.id);
        void session.outbox
          .acknowledge(item.event.id)
          .catch(() => {})
          .finally(() => {
            acknowledging.delete(item.event.id);
            pump();
          });
      }
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
      emit();
    }
  }
  async function release(entry: Entry, locked = false): Promise<void> {
    if (storage && entry.message && !locked) {
      try {
        await storage.lock(entry.id, () => release(entry, true));
      } catch (error) {
        entries = entries.map((item) =>
          item === entry
            ? {
                ...item,
                error: error instanceof Error ? error.message : String(error),
              }
            : item,
        );
        emit();
      }
      return;
    }
    if (!entries.includes(entry) || publishing.has(entry.id)) return;
    publishing.add(entry.id);
    let id: string | undefined;
    try {
      if (storage && entry.message) {
        if (!storage.has(entry.id)) {
          entries = entries.filter((item) => item !== entry);
          return;
        }
        if (!session.outbox)
          throw new Error("Message delivery is unavailable.");
        await session.outbox.ready();
        const previous = session.outbox
          .snapshot()
          .find(
            (item) => item.recovery?.key === followUpRecovery(entry.id).key,
          );
        if (previous) {
          await session.outbox.recover(
            previous.event.id,
            followUpRecovery(entry.id),
          );
          storage.remove(entry.id);
          entries = entries.filter((item) => item !== entry);
          return;
        }
        if (storage.isSending(entry.id))
          throw new Error(
            "This message may already be sending in another window. Reload to recover its delivery. If it was interrupted before sending, check the conversation before removing this row and sending again.",
          );
      }
      if (entry.beforeRelease) await entry.beforeRelease();
      if (!entries.includes(entry)) return;
      if (!requested.has(entry.id) && blockers(entry.channelId)) return;
      if (storage && entry.message && !storage.has(entry.id)) return;
      entry.beforePublish?.();
      requested.get(entry.id)?.();
      if (storage && entry.message) storage.sending(entry.id, true);
      try {
        id = sent(
          entry,
          entry.message ? followUpRecovery(entry.id) : undefined,
        );
      } catch (error) {
        if (storage && entry.message) storage.sending(entry.id, false);
        throw error;
      }
      if (storage && entry.message) {
        if (!session.outbox)
          throw new Error("Message delivery is unavailable.");
        await session.outbox.recover(id, followUpRecovery(entry.id));
        storage.remove(entry.id);
      }
      entries = entries.filter((item) => item !== entry);
    } catch (error) {
      entries = entries.map((item) =>
        item === entry
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    } finally {
      publishing.delete(entry.id);
      requested.delete(entry.id);
      emit();
      reconcileDelivery();
      queueMicrotask(pump);
    }
    // Presentation failures cannot put an already accepted message back in queue.
    if (id) entry.onSend?.(id);
  }
  function pump() {
    if (activating) return;
    for (const channelId of new Set([
      ...waits.keys(),
      ...entries.map((entry) => entry.channelId),
    ])) {
      if (
        entries.some(
          (entry) => entry.channelId === channelId && publishing.has(entry.id),
        )
      )
        continue;
      if (blockers(channelId)) continue;
      const first = entries.find((entry) => entry.channelId === channelId);
      if (first && !first.error && !first.restored) void release(first);
    }
    if (
      !entries.length &&
      !waits.size &&
      !session.outbox
        ?.snapshot()
        .some(
          (item) =>
            item.recovery?.key.startsWith("follow-up:") && !item.acknowledged,
        )
    ) {
      const dispose = stop;
      stop = undefined;
      dispose?.();
    }
  }
  function remove(id: string) {
    const entry = entries.find((item) => item.id === id);
    try {
      if (entry?.message) storage?.remove(id);
      requested.delete(id);
      entries = entries.filter((item) => item.id !== id);
    } catch (error) {
      entries = entries.map((item) =>
        item.id === id
          ? {
              ...item,
              error: error instanceof Error ? error.message : String(error),
            }
          : item,
      );
    }
    emit();
  }
  const onStorage = () => {
    restore();
    if (entries.length) watch();
    emit();
    pump();
  };
  if (entries.length) watch();
  if (storage && session.outbox)
    void session.outbox
      .ready()
      .then(() => {
        if (
          session.outbox
            ?.snapshot()
            .some(
              (item) =>
                item.recovery?.key.startsWith("follow-up:") &&
                !item.acknowledged,
            )
        ) {
          watch();
          reconcileDelivery();
        }
      })
      .catch(() => {});
  return {
    snapshot: () => entries,
    storageError: () => storageError,
    subscribe(listener: () => void) {
      if (storage && !listeners.size) {
        onStorage();
        window.addEventListener("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (storage && !listeners.size)
          window.removeEventListener("storage", onStorage);
      };
    },
    /** `validated` means the caller checked recipients just now; only a later release revalidates. */
    submit(entry: Omit<Entry, "id">, validated = false) {
      // Upload completion can arrive after the removal notification, even before
      // this queue exists. Reject before allocating a slot so upload recovery runs.
      if (
        !session.channels
          .list()
          .channels.some(
            (row) =>
              row.id === entry.channelId && (!row.readOnly || row.cached),
          )
      )
        throw new Error("This chat is no longer available for sending.");
      if (entry.message) restore();
      if (entry.message && (!storage || storageError))
        throw new Error(
          storageError ?? "Queued message storage is unavailable.",
        );
      watch();
      if (
        (validated || !entry.beforeRelease) &&
        !blockers(entry.channelId) &&
        !entries.some((item) => item.channelId === entry.channelId)
      )
        return sent(entry);
      if (entries.length >= 50)
        throw new Error(
          "The follow-up queue is full. Send or remove a queued message first.",
        );
      const id = crypto.randomUUID();
      if (entry.message) {
        if (!storage) throw new Error("Queued message storage is unavailable.");
        storage.save({ ...entry.message, id, createdAt: ++sequence });
      }
      entries = [...entries, { ...entry, id }];
      watch();
      emit();
      pump();
      return undefined;
    },
    /** Resume only the chats the runner is actually recovering. Seed the
     * request barriers before it reads/restarts them, including reconnects. */
    resumeAfter(
      agent: string,
      turns: Readonly<Record<string, string>>,
      beforePublish?: (entry: Pick<Entry, "channelId" | "recipients">) => void,
    ) {
      restore();
      const channels = new Set(Object.values(turns).filter(Boolean));
      for (const [message, channelId] of Object.entries(turns)) {
        if (
          !channelId ||
          !entries.some((entry) => entry.channelId === channelId)
        )
          continue;
        resumedRequests.add(`${agent}:${message}`);
        waits.set(channelId, [
          ...(waits.get(channelId) ?? []),
          { agent, message, resumed: true },
        ]);
      }
      entries = entries.map((entry) =>
        entry.restored && channels.has(entry.channelId)
          ? {
              ...entry,
              restored: false,
              beforePublish: () => beforePublish?.(entry),
            }
          : entry,
      );
      if (entries.length) watch();
      emit();
      // Other agents in the same Resume decision seed their barriers first.
      queueMicrotask(pump);
    },
    sendNow(id: string, beforePublish?: () => void) {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        requested.set(id, beforePublish);
        void release(entry);
      }
    },
    remove(id: string) {
      remove(id);
      reconcileDelivery();
      pump();
    },
  };
}
