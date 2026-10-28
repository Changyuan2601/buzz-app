import type { RelayEvent } from "./events";
import type { ReadApi, ReadIntent, ServerChannelRow } from "./read-api";
import type { ReadTarget } from "./read-state-model";
import type { ReadMutationResult, ReadSyncSnapshot } from "./read-state";
import type { RelayReader } from "./reader";
import { threadReference } from "./thread-reference";
import type {
  RemoteReadDecision,
  UnreadCapability,
  UnreadSnapshot,
} from "./unread";

const broadcast = (event: RelayEvent) =>
  event.tags.some(([name, value]) => name === "broadcast" && value === "1");

/**
 * Per-message answers from the relay's rows. A read row reads every message
 * in its scope; in an unread row, the latest is unread and the rest are asked
 * of `/me/coverage`, which orders by arrival. Without coverage, comparing
 * author time with the anchor's is an approximation: a backdated message
 * after the anchor reads as read.
 */
export function serverReadDecision({
  api,
  reader,
  event,
}: {
  api: ReadApi;
  reader: RelayReader;
  /** A retained verified event, from unread evidence. */
  event: (id: string) => RelayEvent | undefined;
}): RemoteReadDecision {
  const anchors = new Map<string, number>();
  const wanted = new Set<string>();
  const failed = new Set<string>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetchAnchors = () => {
    timer = undefined;
    const ids = [...wanted].slice(0, 100);
    for (const id of ids) wanted.delete(id);
    if (!ids.length) return;
    void reader
      .read([{ ids, limit: ids.length }], { priority: "background" })
      .then((events) => {
        for (const found of events) anchors.set(found.id, found.created_at);
        for (const id of ids) if (!anchors.has(id)) failed.add(id);
        for (const listener of listeners) listener();
      })
      .catch(() => {
        for (const id of ids) failed.add(id);
      })
      .finally(() => {
        if (wanted.size && !timer) timer = setTimeout(fetchAnchors, 0);
      });
  };
  const anchorTime = (id: string) => {
    const known = anchors.get(id) ?? event(id)?.created_at;
    if (known !== undefined || failed.has(id)) return known;
    wanted.add(id);
    timer ??= setTimeout(fetchAnchors, 0);
    return undefined;
  };
  // Exact answers, valid while the scope's anchor stays the same: a later
  // arrival moves only the latest, which reads no earlier message and unreads
  // no read one. A broadcast reply sits in two scopes, so answers key by
  // message and scope.
  const covered = new Map<string, boolean | undefined>();
  // A scope's anchor only moves forward, so a message read there once stays
  // read under every later anchor.
  const settled = new Set<string>();
  const settle = (key: string) => {
    settled.add(key);
    for (const oldest of settled) {
      if (settled.size <= 5000) break;
      settled.delete(oldest);
    }
  };
  const asking = new Map<
    string,
    { id: string; channelId: string; rootId: string | undefined }
  >();
  const cover = (key: string, answer: boolean | undefined) => {
    covered.delete(key);
    covered.set(key, answer);
    for (const oldest of covered.keys()) {
      if (covered.size <= 5000) break;
      covered.delete(oldest);
    }
  };
  let coverTimer: ReturnType<typeof setTimeout> | undefined;
  let staleAnswers = 0;
  const latestOf = (channelId: string, rootId: string | undefined) => {
    const row = api.row(channelId);
    const scoped = rootId
      ? row?.threads.find((thread) => thread.root_id === rootId)
      : row?.unread
        ? row
        : undefined;
    return (
      scoped && { anchor: scoped.read_through_id, latest: scoped.latest_id }
    );
  };
  const askCoverage = () => {
    coverTimer = undefined;
    const batch = [...asking].slice(0, 100);
    for (const [key] of batch) asking.delete(key);
    // A live message asked about before its row caught up may now be the
    // scope's latest, which is unread without asking.
    const ask = batch.filter(([key, { id, channelId, rootId }]) => {
      const now = latestOf(channelId, rootId);
      if (
        !now ||
        now.latest !== id ||
        key !== `${id}|${rootId ?? ""}|${now.anchor}`
      )
        return true;
      cover(key, true);
      return false;
    });
    if (ask.length < batch.length) for (const listener of listeners) listener();
    if (!ask.length || !api.host.coverage) return;
    void api.host
      .coverage(
        [...new Set(ask.map(([, { id }]) => id))],
        AbortSignal.timeout(10000),
      )
      .then(({ messages, read_revision }) => {
        // Older than a response already applied: ask again, a few times.
        if (api.stale(read_revision) && ++staleAnswers <= 3) {
          for (const [key, value] of ask) asking.set(key, value);
          return;
        }
        staleAnswers = 0;
        for (const [key, { id, rootId }] of ask) {
          const answer = messages[id];
          if (answer === "read") settle(`${id}|${rootId ?? ""}`);
          cover(
            key,
            answer === "read" || answer === "unread"
              ? answer === "unread"
              : undefined,
          );
        }
        for (const listener of listeners) listener();
      })
      .catch(() => {
        // Unanswered messages keep the local decision until the next change.
        for (const [key] of ask) cover(key, undefined);
      })
      .finally(() => {
        if (asking.size && !coverTimer) coverTimer = setTimeout(askCoverage, 0);
      });
  };
  const scope = (
    message: RelayEvent,
    unread: boolean,
    anchor: string | null,
    latest: string | null,
    channelId: string,
    rootId: string | undefined,
  ) => {
    if (!unread) return false;
    const scoped = `${message.id}|${rootId ?? ""}`;
    if (message.id === anchor) {
      settle(scoped);
      return false;
    }
    if (settled.has(scoped)) return false;
    const key = `${scoped}|${anchor}`;
    if (message.id === latest) {
      // Still unread once a later arrival replaces it.
      if (api.host.coverage) cover(key, true);
      return true;
    }
    if (api.host.coverage) {
      if (covered.has(key)) return covered.get(key);
      if (!asking.has(key)) {
        asking.set(key, { id: message.id, channelId, rootId });
        coverTimer ??= setTimeout(askCoverage, 20);
      }
      return undefined;
    }
    if (!anchor) return undefined;
    const time = anchorTime(anchor);
    return time === undefined ? undefined : message.created_at > time;
  };
  return {
    unread(message, channelId, threadRootId) {
      if (!api.complete()) return undefined;
      const row = api.row(channelId);
      if (!row) return undefined;
      const timeline =
        !threadRootId || broadcast(message)
          ? scope(
              message,
              row.unread,
              row.read_through_id,
              row.latest_id,
              channelId,
              undefined,
            )
          : false;
      if (!threadRootId) return timeline;
      const thread = row.threads.find(
        (candidate) => candidate.root_id === threadRootId,
      );
      const replies = thread
        ? scope(
            message,
            true,
            thread.read_through_id,
            thread.latest_id,
            channelId,
            threadRootId,
          )
        : row.threads_truncated
          ? undefined
          : false;
      if (timeline === true || replies === true) return true;
      return timeline === undefined || replies === undefined
        ? undefined
        : false;
    },
    following: (channelId, rootId) =>
      api.complete() ? api.following(channelId, rootId) : undefined,
    subscribe(listener) {
      const stop = api.subscribe(listener);
      listeners.add(listener);
      return () => {
        stop();
        listeners.delete(listener);
      };
    },
  };
}

const sameSnapshot = (a: UnreadSnapshot, b: UnreadSnapshot) =>
  a.observedCount === b.observedCount &&
  a.attentionCount === b.attentionCount &&
  a.coverage === b.coverage &&
  a.freshness === b.freshness &&
  a.manual === b.manual &&
  a.error === b.error &&
  a.latestMessage?.id === b.latestMessage?.id;

/**
 * The unread capability with sidebar and thread rows from the relay, and
 * reading intent sent to it. Consumers keep the same contract. Per-message
 * state, Inbox and thread activity stay local evidence decided by the rows
 * (`serverReadDecision`). Manual unread stays on this device.
 */
export function withServerReadState({
  local,
  api,
  event,
  isDm,
  canFollow,
}: {
  local: UnreadCapability;
  api: ReadApi;
  event: (id: string) => RelayEvent | undefined;
  isDm: (channelId: string) => boolean;
  canFollow: boolean;
}): UnreadCapability {
  const cache = new Map<string, UnreadSnapshot>();
  let syncSnapshot: ReadSyncSnapshot | undefined;

  const threadAttention = (row: ServerChannelRow) =>
    row.threads.reduce(
      (sum, thread) => sum + (thread.unread ? Math.max(1, thread.mentions) : 0),
      0,
    );
  function snapshot(target: ReadTarget): UnreadSnapshot {
    const base = local.snapshot(target);
    const row = api.complete() ? api.row(target.channelId) : undefined;
    if (target.kind === "message" || !row) return base;
    let observed: number;
    let attention: number;
    if (target.kind === "thread") {
      const thread = row.threads.find((t) => t.root_id === target.rootId);
      if (!thread && row.threads_truncated) return base;
      observed = attention = thread?.unread ? Math.max(1, thread.mentions) : 0;
    } else {
      attention = row.mentions + threadAttention(row);
      // The relay says whether the timeline is unread, not whether it is all
      // mentions; local evidence (decided by the same rows) tells them apart.
      const localOrdinary = Math.max(
        0,
        (base.observedCount ?? 0) - (base.attentionCount ?? 0),
      );
      const ordinary = row.unread
        ? isDm(target.channelId)
          ? 0
          : Math.max(localOrdinary, row.mentions ? 0 : 1)
        : 0;
      observed = ordinary + attention;
    }
    if (base.manual !== "none") observed = Math.max(observed, 1);
    const status = api.status();
    const next: UnreadSnapshot = Object.freeze({
      target,
      ...(base.latestMessage ? { latestMessage: base.latestMessage } : {}),
      observedCount: observed,
      attentionCount: attention,
      coverage: "observed",
      freshness: status.status === "error" ? "stale" : "observed",
      manual: base.manual,
      error: status.error,
    });
    const key = `${target.kind}:${target.channelId}:${target.kind === "thread" ? target.rootId : ""}`;
    const old = cache.get(key);
    if (old && sameSnapshot(old, next)) return old;
    cache.set(key, next);
    return next;
  }

  const markThrough = (
    target: ReadIntent["target"],
    messageId: string,
  ): ReadIntent => ({ type: "mark_through", target, message_id: messageId });
  /** Mark a message's scope on the relay through it. Without the retained
   * event its scope is unknown, so nothing is sent. */
  const markMessage = (channelId: string, messageId: string): ReadIntent[] => {
    const found = event(messageId);
    if (!found) return [];
    const rootId = threadReference(found)?.rootId;
    return [
      markThrough(
        rootId && !broadcast(found)
          ? { channel_id: channelId, root_id: rootId }
          : { channel_id: channelId },
        messageId,
      ),
    ];
  };
  /** Explicit "read everything here": each listed scope through its latest. */
  function channelIntents(channelId: string): ReadIntent[] {
    const row = api.row(channelId);
    if (!row) {
      const latest = local.snapshot({ kind: "channel", channelId })
        .latestMessage?.id;
      return latest ? markMessage(channelId, latest) : [];
    }
    return [
      ...(row.latest_id && row.unread
        ? [markThrough({ channel_id: channelId }, row.latest_id)]
        : []),
      ...row.threads.flatMap((thread) =>
        thread.latest_id
          ? [
              markThrough(
                { channel_id: channelId, root_id: thread.root_id },
                thread.latest_id,
              ),
            ]
          : [],
      ),
    ];
  }
  function send(intents: readonly ReadIntent[]) {
    for (const intent of intents)
      if (intent.type === "mark_through")
        api.readLocally(
          intent.target.channel_id,
          intent.target.root_id,
          intent.message_id,
        );
    api.enqueue(intents);
  }
  const withIntents = async (
    result: Promise<ReadMutationResult>,
    intents: readonly ReadIntent[],
  ) => {
    send(intents);
    return result;
  };

  return Object.freeze<UnreadCapability>({
    ...local,
    snapshot,
    subscribe(target, listener) {
      const stopLocal = local.subscribe(target, listener);
      const stopApi = api.subscribe(listener);
      return () => {
        stopLocal();
        stopApi();
      };
    },
    sync() {
      const status = api.status();
      const next: ReadSyncSnapshot = Object.freeze({
        capability: "frontier-sync",
        status:
          status.status === "loading"
            ? "loading"
            : status.error
              ? "error"
              : status.pending
                ? "pending"
                : "reconciled",
        completeness: api.complete() ? "snapshot" : "unknown",
        ...(status.error ? { error: status.error } : {}),
      });
      if (
        syncSnapshot &&
        syncSnapshot.status === next.status &&
        syncSnapshot.completeness === next.completeness &&
        syncSnapshot.error === next.error
      )
        return syncSnapshot;
      syncSnapshot = next;
      return next;
    },
    subscribeSync(listener) {
      const stopLocal = local.subscribeSync(listener);
      const stopApi = api.subscribe(listener);
      return () => {
        stopLocal();
        stopApi();
      };
    },
    async ensure() {
      await Promise.all([
        local.ensure(),
        api.complete() ? undefined : api.load(),
      ]);
    },
    async refresh() {
      await Promise.all([local.refresh(), api.load()]);
    },
    async retrySync() {
      await Promise.all([local.retrySync(), api.flush()]);
    },
    reading(channelId) {
      const inner = local.reading(channelId);
      const dm = () => isDm(channelId);
      return Object.freeze({
        view: inner.view,
        async observe(messageIds) {
          // Mentions, broadcasts and DMs read on every device: each viewed
          // one moves its scope through it. Ordinary rows stay on this device.
          const intents = messageIds.flatMap((id) => {
            const attention = local.attention(channelId, id);
            if (!attention.unread) return [];
            const found = event(id);
            if (!dm() && !attention.mentioned && !(found && broadcast(found)))
              return [];
            return markMessage(channelId, id);
          });
          await inner.observe(messageIds);
          send(intents);
        },
        async catchUp(messageId, rootId) {
          await inner.catchUp(messageId, rootId);
          // Catch-up repeats at every dwell; only an unread scope needs a write.
          const row = api.row(channelId);
          if (
            row &&
            (rootId
              ? !row.threads_truncated &&
                !row.threads.some((thread) => thread.root_id === rootId)
              : !row.unread)
          )
            return;
          send(
            rootId
              ? [
                  markThrough(
                    { channel_id: channelId, root_id: rootId },
                    messageId,
                  ),
                ]
              : markMessage(channelId, messageId),
          );
        },
        dispose: inner.dispose,
      });
    },
    following(channelId, rootId) {
      return (
        api.following(channelId, rootId) ?? local.following(channelId, rootId)
      );
    },
    follow(channelId, rootId, following) {
      local.follow(channelId, rootId, following);
      if (canFollow)
        api.enqueue([
          {
            type: following ? "follow" : "unfollow",
            target: { channel_id: channelId, root_id: rootId },
          },
        ]);
    },
    markThrough(target, messageId) {
      return withIntents(
        local.markThrough(target, messageId),
        target.kind === "thread"
          ? [
              markThrough(
                { channel_id: target.channelId, root_id: target.rootId },
                messageId,
              ),
            ]
          : target.kind === "channel"
            ? [markThrough({ channel_id: target.channelId }, messageId)]
            : markMessage(target.channelId, messageId),
      );
    },
    markMessageRead(channelId, messageId) {
      return withIntents(
        local.markMessageRead(channelId, messageId),
        markMessage(channelId, messageId),
      );
    },
    markChannelRead(channelId) {
      return withIntents(
        local.markChannelRead(channelId),
        channelIntents(channelId),
      );
    },
    prepareChannelRead(channelId) {
      const inner = local.prepareChannelRead(channelId);
      const intents = channelIntents(channelId);
      return () => withIntents(inner(), intents);
    },
    async markAllChannelsRead() {
      const intents = [...api.rows().values()]
        .filter((row) => row.unread || row.threads.length)
        .flatMap((row) => channelIntents(row.channel_id));
      const results = await local.markAllChannelsRead();
      send(intents);
      return results;
    },
  });
}
