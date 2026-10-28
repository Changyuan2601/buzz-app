import type { RelayEvent } from "./events";
import { threadReference } from "./thread-reference";

/** Server-owned read state (`/buzz/v1`, docs/buzz-v1-read-state.md in block/buzz).
 * The relay decides unread and mentions; the client replaces rows with each
 * response and keeps them current from live events between loads. */
export type ServerThreadRow = Readonly<{
  root_id: string;
  unread: boolean;
  mentions: number;
  read_through_id: string | null;
  latest_id: string | null;
}>;
export type ServerChannelRow = Readonly<{
  channel_id: string;
  unread: boolean;
  mentions: number;
  read_through_id: string | null;
  latest_id: string | null;
  threads: readonly ServerThreadRow[];
  /** Present when the relay cut thread rows at its cap. */
  threads_truncated?: boolean;
  /** Every live follow in the channel, read or unread, newest reply first;
   * a root not listed is not followed unless the list was cut at its cap. */
  followed_threads?: readonly string[];
  followed_threads_truncated?: boolean;
}>;
export type ReadIntent =
  | Readonly<{
      type: "mark_through";
      target: Readonly<{ channel_id: string; root_id?: string }>;
      message_id: string;
    }>
  | Readonly<{
      type: "follow" | "unfollow";
      target: Readonly<{ channel_id: string; root_id: string }>;
    }>;
export type ReadOutcome = Readonly<{ status: string; retryable?: boolean }>;
export type SidebarPage = Readonly<{
  channels: readonly ServerChannelRow[];
  next_cursor: string | null;
  /** The viewer's read-state revision in the same snapshot as the rows. */
  read_revision?: number;
}>;
/** Host boundary: the host signs NIP-98; the page never holds the key. */
export interface ReadApiHost {
  readonly capabilities: readonly string[];
  readonly eligibleKinds: readonly number[];
  readonly maxChannels: number;
  readonly maxIntents: number;
  sidebar(
    query: Readonly<{ cursor?: string; channelIds?: readonly string[] }>,
    signal: AbortSignal,
  ): Promise<SidebarPage>;
  /** Exact per-message answers in relay arrival order, when advertised. */
  coverage?(
    messageIds: readonly string[],
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      messages: Readonly<Record<string, "read" | "unread" | "unknown">>;
      read_revision?: number;
    }>
  >;
  write(
    intents: readonly ReadIntent[],
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      outcomes: readonly ReadOutcome[];
      channels?: readonly ServerChannelRow[];
      /** The ping this write sent, so its own echo can be skipped. */
      ping_id?: string;
      /** Omitted when the relay could not read it in time. */
      read_revision?: number;
      /** The revision just before this write's first applied intent. */
      read_revision_from?: number;
    }>
  >;
}

const intentKey = (intent: ReadIntent) =>
  `${intent.type}:${intent.target.channel_id}:${intent.target.root_id ?? ""}:${"message_id" in intent ? intent.message_id : ""}`;
/** Repeating a mark changes nothing; a repeated follow may undo an unfollow. */
const repeatable = (intent: ReadIntent) => intent.type !== "mark_through";
/** How long a revision gap may stay open for its ping before a full load. */
const GAP_MS = 1500;

export type ReadApiStatus = Readonly<{
  status: "loading" | "ready" | "error";
  /** Intents saved here and not yet resolved by the relay. */
  pending: number;
  error?: string | undefined;
  /** Wall ms of the last complete sidebar load. */
  loadedAt?: number | undefined;
}>;

export type ReadApi = ReturnType<typeof createReadApi>;

/**
 * One owner for the relay's sidebar rows. Loads on start, reconnect and wake;
 * otherwise rows change only from live events this client already receives,
 * write responses and targeted refreshes after a ping. No polling.
 */
export function createReadApi({
  host,
  viewer,
  storageKey,
  notify = (listener) => listener(),
  isDm,
  rootAuthor,
}: {
  host: ReadApiHost;
  viewer: string;
  /** localStorage key for unresolved intents; omit for memory only. */
  storageKey?: string | undefined;
  notify?: (listener: () => void) => void;
  isDm: (channelId: string) => boolean;
  /** Author of a loaded root event, to follow replies to the viewer's roots. */
  rootAuthor: (rootId: string) => string | undefined;
}) {
  let closed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const rows = new Map<string, ServerChannelRow>();
  let complete = false;
  let state: ReadApiStatus = Object.freeze({ status: "loading", pending: 0 });
  let loading: Promise<void> | undefined;
  let revision = 0;
  const refreshQueue = new Set<string>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let staleRefreshes = 0;
  const askQueue = new Set<string>();
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let retryMs = 1000;
  let repairMs = 2000;
  let repairTimer: ReturnType<typeof setTimeout> | undefined;
  const eligible = new Set(host.eligibleKinds);
  const ownPings = new Set<string>();

  const storage =
    storageKey && typeof localStorage !== "undefined"
      ? localStorage
      : undefined;
  let queue: ReadIntent[] = (() => {
    try {
      const saved = storage?.getItem(storageKey ?? "");
      const parsed = saved ? (JSON.parse(saved) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as ReadIntent[]) : [];
    } catch {
      return [];
    }
  })();
  const persist = () => {
    try {
      if (queue.length)
        storage?.setItem(storageKey ?? "", JSON.stringify(queue));
      else storage?.removeItem(storageKey ?? "");
    } catch {
      // A full or disabled store keeps the queue in memory for this session.
    }
  };
  const emit = () => {
    revision++;
    if (!closed) for (const listener of listeners) notify(listener);
  };
  const health = (patch: Partial<ReadApiStatus>) => {
    state = Object.freeze({ ...state, pending: queue.length, ...patch });
    emit();
  };
  // The relay's per-viewer revision moves with every applied intent from any
  // install. A response older than the highest seen is dropped and asked again.
  let highWater = 0;
  const behind = (revision: number | undefined) =>
    revision !== undefined && revision < highWater;
  const raise = (revision: number | undefined) => {
    if (revision !== undefined && revision > highWater) highWater = revision;
  };
  // Rows reflect every intent through `reconciled`. A full load sets it to
  // its oldest page's revision; each ping or write answer (`from`..`to`)
  // extends it when it starts there, since its channels are refetched or
  // replaced. A range starting later means a missed ping: a full load repairs.
  let reconciled = 0;
  const ranges = new Map<number, number>();
  const through = (start: number) => {
    let at = start;
    for (let moved = true; moved; ) {
      moved = false;
      for (const [from, to] of ranges)
        if (from <= at && to > at) {
          at = to;
          moved = true;
        }
    }
    return at;
  };
  const reconcile = (at: number) => {
    reconciled = through(Math.max(reconciled, at));
    for (const [from, to] of ranges) if (to <= reconciled) ranges.delete(from);
  };
  function advance(from: number | undefined, to: number | undefined) {
    if (to === undefined || to <= reconciled) return;
    const start = from ?? to - 1;
    ranges.set(start, Math.max(ranges.get(start) ?? 0, to));
    reconcile(reconciled);
    if (ranges.size) awaitGap();
  }
  // A range past `reconciled` is often early, not missed: pings wait for an
  // own write in flight, and concurrent writes answer out of order. Give the
  // missing ping a moment before repairing with a full load.
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  function awaitGap() {
    if (gapTimer || closed) return;
    gapTimer = setTimeout(() => {
      gapTimer = undefined;
      // A load in flight decides once it knows its own revision.
      if (ranges.size && !loading) void load();
    }, GAP_MS);
  }
  // Responses can land out of order. A channel takes a response's row unless
  // it already holds one read at a later revision or, at the same or unknown
  // revision, from a later-issued request or local change. A local change
  // newer than a response may be missing from it, so the channel is refetched.
  let sequence = 0;
  const written = new Map<
    string,
    Readonly<{ at: number; local: boolean; revision?: number }>
  >();
  const issue = () => ++sequence;
  // Follow state. A relay row with `followed_threads` decides for its
  // channel; changes this install made since, or still has queued, win until
  // the next one. Without the field, a follow is remembered from rows that
  // listed the thread unread and from this install's own intents.
  const follows = new Map<
    string,
    Readonly<{ following: boolean; at: number; revision?: number }>
  >();
  const noteFollow = (
    channelId: string,
    rootId: string,
    following: boolean,
    at: number,
    revision?: number,
  ) => {
    const key = `${channelId}:${rootId}`;
    if ((follows.get(key)?.at ?? 0) <= at)
      follows.set(key, {
        following,
        at,
        ...(revision === undefined ? {} : { revision }),
      });
  };
  /** When each channel's row last came from the relay, and at what revision. */
  const fromRelay = new Map<
    string,
    Readonly<{ at: number; revision?: number }>
  >();
  // Replies whose follow the relay was asked about: a relay row read after
  // the reply that does not list the thread means it is not followed.
  const probes = new Map<string, number>();
  const noteListed = (
    row: ServerChannelRow,
    at: number,
    relay: boolean,
    revision?: number,
  ) => {
    const followed = row.followed_threads;
    if (!followed)
      for (const thread of row.threads)
        noteFollow(row.channel_id, thread.root_id, true, at);
    if (!relay) return;
    fromRelay.set(row.channel_id, {
      at,
      ...(revision === undefined ? {} : { revision }),
    });
    for (const [key, asked] of probes)
      if (key.startsWith(`${row.channel_id}:`) && asked < at) {
        probes.delete(key);
        const rootId = key.slice(row.channel_id.length + 1);
        if (
          followed
            ? !followed.includes(rootId)
            : !row.threads_truncated &&
              !row.threads.some((thread) => thread.root_id === rootId)
        )
          noteFollow(row.channel_id, rootId, false, at, revision);
      }
  };
  /** Whether the relay follows this thread for the viewer, when known. */
  function followOf(channelId: string, rootId: string) {
    for (let index = queue.length - 1; index >= 0; index--) {
      const intent = queue[index];
      if (
        intent?.type !== "mark_through" &&
        intent?.target.channel_id === channelId &&
        intent.target.root_id === rootId
      )
        return intent.type === "follow";
    }
    const known = follows.get(`${channelId}:${rootId}`);
    const row = rows.get(channelId);
    const followed = row?.followed_threads;
    if (!row || !followed) return known?.following;
    const relay = fromRelay.get(channelId);
    if (known && known.at > (relay?.at ?? 0)) return known.following;
    if (
      followed.includes(rootId) ||
      row.threads.some((thread) => thread.root_id === rootId)
    )
      return true;
    if (!row.followed_threads_truncated) return false;
    // Past the cap, only a refresh at the row's revision that omitted the
    // thread says it is not followed.
    return known?.revision !== undefined && known.revision === relay?.revision
      ? known.following
      : undefined;
  }
  const settle = (
    issued: number,
    revision: (channelId: string) => number | undefined,
    next: readonly ServerChannelRow[],
    absent: readonly string[] = [],
  ) => {
    const stale: string[] = [];
    const take = (channelId: string, row?: ServerChannelRow) => {
      const last = written.get(channelId);
      const at = revision(channelId);
      const newer =
        at !== undefined && last?.revision !== undefined && at !== last.revision
          ? at > last.revision
          : !last || last.at <= issued;
      if (!newer) {
        if (last?.local) stale.push(channelId);
        return;
      }
      written.set(channelId, {
        at: issued,
        local: false,
        ...(at === undefined ? {} : { revision: at }),
      });
      if (row) {
        // Write answers omit the follow list: keep the last read's, which
        // still predates this install's intents.
        const previous = rows.get(channelId)?.followed_threads;
        const kept: ServerChannelRow =
          row.followed_threads || !previous
            ? row
            : {
                ...row,
                followed_threads: previous,
                ...(rows.get(channelId)?.followed_threads_truncated
                  ? { followed_threads_truncated: true }
                  : {}),
              };
        rows.set(channelId, Object.freeze(kept));
        noteListed(kept, issued, kept === row, at);
      } else {
        rows.delete(channelId);
        fromRelay.delete(channelId);
      }
    };
    for (const row of next) take(row.channel_id, row);
    for (const id of absent) take(id);
    if (stale.length) refresh(stale);
  };
  const writeLocally = (channelId: string, row: ServerChannelRow) => {
    const at = issue();
    written.set(channelId, { at, local: true });
    rows.set(channelId, Object.freeze(row));
    noteListed(row, at, false);
  };

  let reload = false;
  /** `again`: a load already in flight may predate the change; run another. */
  async function load(again = false): Promise<void> {
    if (closed) return;
    if (loading) {
      reload ||= again;
      return loading;
    }
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30000),
    ]);
    loading = (async () => {
      try {
        // Pages are separate snapshots. The traversal holds only if every
        // intent after its oldest page is a ping or write answer seen while
        // it ran, whose channels were refetched; otherwise read it again.
        for (let attempt = 0; ; attempt++) {
          const issued = issue();
          const next = new Map<string, ServerChannelRow>();
          const revisions = new Map<string, number>();
          let oldest: number | undefined;
          let cursor: string | undefined;
          for (let page = 0; page < 500; page++) {
            const result = await host.sidebar(cursor ? { cursor } : {}, signal);
            for (const row of result.channels) {
              next.set(row.channel_id, row);
              if (result.read_revision !== undefined)
                revisions.set(row.channel_id, result.read_revision);
            }
            if (result.read_revision !== undefined)
              oldest = Math.min(oldest ?? Infinity, result.read_revision);
            raise(result.read_revision);
            if (!result.next_cursor) break;
            cursor = result.next_cursor;
          }
          if (closed) return;
          if (oldest !== undefined && through(oldest) < highWater) {
            if (attempt === 2)
              throw new Error("Read state kept changing during the load");
            continue;
          }
          settle(
            issued,
            (channelId) => revisions.get(channelId) ?? oldest,
            [...next.values()],
            [...rows.keys()].filter((id) => !next.has(id)),
          );
          if (oldest !== undefined) reconcile(oldest);
          if (ranges.size) awaitGap();
          break;
        }
        complete = true;
        unknownChannels.clear();
        repairMs = 2000;
        health({ status: "ready", error: undefined, loadedAt: Date.now() });
        start();
        void flush();
      } catch (error) {
        if (closed) return;
        health({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        repair();
      } finally {
        loading = undefined;
        if (reload && !closed) {
          reload = false;
          void load();
        }
      }
    })();
    return loading;
  }

  /** The relay counts nothing as unread until the account's first applied
   * intent. Marking a read row through its latest changes no read state but
   * starts the account. Once per install; another install's start is harmless. */
  function start() {
    const key = storageKey && `${storageKey}:started`;
    try {
      if (key && storage?.getItem(key)) return;
    } catch {
      // Without storage, starting again each load costs one no-op write.
    }
    const row = [...rows.values()].find(
      (candidate) => !candidate.unread && candidate.latest_id,
    );
    if (!row?.latest_id) return;
    enqueue([
      {
        type: "mark_through",
        target: { channel_id: row.channel_id },
        message_id: row.latest_id,
      },
    ]);
    try {
      if (key) storage?.setItem(key, "1");
    } catch {
      // As above.
    }
  }
  /** A failed read leaves rows stale until a full load succeeds. */
  function repair() {
    if (repairTimer || closed) return;
    repairTimer = setTimeout(() => {
      repairTimer = undefined;
      void load();
    }, repairMs);
    repairMs = Math.min(repairMs * 2, 60000);
  }
  // Wake: a hidden window may have slept through pings and reconnects.
  let hiddenAt: number | undefined;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt !== undefined && Date.now() - hiddenAt > 30000) {
      hiddenAt = undefined;
      void probe();
    }
  };
  /** Wake on a connected socket: a full load only if the relay's revision
   * moved past ours, which means a ping was missed. Reconnects always load. */
  async function probe() {
    const channelId = rows.keys().next().value;
    if (!complete || !channelId) return load();
    try {
      const issued = issue();
      const result = await host.sidebar(
        { channelIds: [channelId] },
        lifetime.signal,
      );
      if (closed) return;
      raise(result.read_revision);
      if (
        result.read_revision === undefined ||
        result.read_revision > reconciled
      )
        return load();
      if (behind(result.read_revision)) return;
      settle(
        issued,
        () => result.read_revision,
        result.channels,
        result.channels.length ? [] : [channelId],
      );
      emit();
    } catch {
      if (!closed) repair();
    }
  }
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVisibility);
  // Back online: the socket may never have noticed, so pings were missed and
  // queued intents are waiting out their backoff.
  const onOnline = () => {
    if (repairTimer) clearTimeout(repairTimer);
    repairTimer = undefined;
    repairMs = 2000;
    retryMs = 1000;
    void load();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushNow();
    }
  };
  if (typeof window !== "undefined")
    window.addEventListener("online", onOnline);
  /** Targeted reload of some channels, batched to the advertised maximum. */
  function refresh(channelIds: readonly string[]) {
    for (const id of channelIds) refreshQueue.add(id);
    if (refreshTimer || closed) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const ids = [...refreshQueue];
      refreshQueue.clear();
      void (async () => {
        for (let index = 0; index < ids.length; index += host.maxChannels) {
          const batch = ids.slice(index, index + host.maxChannels);
          try {
            const issued = issue();
            const result = await host.sidebar(
              { channelIds: batch },
              lifetime.signal,
            );
            if (closed) return;
            if (behind(result.read_revision)) {
              // Older than an answer already applied: ask again, a few times.
              if (++staleRefreshes > 3) {
                staleRefreshes = 0;
                repair();
                return;
              }
              refresh(batch);
              continue;
            }
            staleRefreshes = 0;
            raise(result.read_revision);
            const present = new Set(
              result.channels.map((row) => row.channel_id),
            );
            settle(
              issued,
              () => result.read_revision,
              result.channels,
              batch.filter((id) => !present.has(id)),
            );
            emit();
          } catch {
            // A ping is only a hint, but its change is real: reload everything.
            if (!closed) repair();
            return;
          }
        }
      })();
    }, 50);
  }

  /** Replies the row cannot decide: ask the relay about their channels. */
  function ask(channelId: string) {
    askQueue.add(channelId);
    askTimer ??= setTimeout(() => {
      askTimer = undefined;
      const ids = [...askQueue];
      askQueue.clear();
      refresh(ids);
    }, 1000);
  }

  function enqueue(intents: readonly ReadIntent[]) {
    if (!intents.length || closed) return;
    const seen = new Set(queue.map(intentKey));
    for (const intent of intents) {
      const key = intentKey(intent);
      if (!repeatable(intent) && seen.has(key)) continue;
      seen.add(key);
      queue.push(intent);
      if (intent.type !== "mark_through")
        noteFollow(
          intent.target.channel_id,
          intent.target.root_id,
          intent.type === "follow",
          issue(),
        );
    }
    persist();
    health({});
    if (!flushTimer && !flushing) flushTimer = setTimeout(flushNow, 150);
  }
  function flushNow() {
    flushTimer = undefined;
    void flush();
  }
  async function flush(): Promise<void> {
    if (closed || !queue.length) return;
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        while (queue.length && !closed) {
          const batch = queue.slice(0, host.maxIntents);
          const issued = issue();
          const result = await host.write(batch, lifetime.signal);
          if (result.ping_id) ownPings.add(result.ping_id);
          raise(result.read_revision);
          advance(
            result.read_revision_from ??
              (result.read_revision === undefined
                ? undefined
                : result.read_revision -
                  result.outcomes.filter((o) => o.status === "applied").length),
            result.read_revision,
          );
          const retry: ReadIntent[] = [];
          batch.forEach((intent, index) => {
            const outcome = result.outcomes[index];
            if (!outcome || outcome.retryable) retry.push(intent);
          });
          const done = new Set(batch.map(intentKey));
          for (const intent of retry) done.delete(intentKey(intent));
          queue = [
            ...retry,
            ...queue
              .slice(batch.length)
              .filter((i) => repeatable(i) || !done.has(intentKey(i))),
          ];
          persist();
          if (result.channels)
            settle(issued, () => result.read_revision, result.channels);
          else
            refresh([
              ...new Set(batch.map((intent) => intent.target.channel_id)),
            ]);
          retryMs = 1000;
          health({ error: undefined });
          if (retry.length === batch.length)
            throw new Error("Read intents unresolved");
        }
      } catch (error) {
        if (closed) return;
        health({
          error: error instanceof Error ? error.message : String(error),
        });
        // A refused request will be refused again: drop it so the rest can go.
        const status = (error as { status?: unknown } | null)?.status;
        if (status === 400 || status === 422) {
          queue = queue.slice(host.maxIntents);
          persist();
          health({ pending: queue.length });
        }
        flushTimer = setTimeout(flushNow, retryMs);
        retryMs = Math.min(retryMs * 2, 60000);
      } finally {
        flushing = undefined;
      }
    })();
    return flushing;
  }

  const mentionsViewer = (event: RelayEvent) =>
    event.tags.some(([name, value]) => name === "p" && value === viewer);
  const broadcast = (event: RelayEvent) =>
    event.tags.some(([name, value]) => name === "broadcast" && value === "1");
  const channelOf = (event: RelayEvent) => {
    const tags = event.tags.filter(([name]) => name === "h");
    return tags.length === 1 ? tags[0]?.[1] : undefined;
  };

  // Live delivery can repeat an event; channels the relay did not know are
  // asked about once per full load.
  const observed = new Set<string>();
  const unknownChannels = new Set<string>();

  /** Keep rows current from a verified live arrival, as the relay would count it. */
  function observe(event: RelayEvent) {
    if (closed || !eligible.has(event.kind) || observed.has(event.id)) return;
    observed.add(event.id);
    for (const oldest of observed) {
      if (observed.size <= 2000) break;
      observed.delete(oldest);
    }
    const channelId = channelOf(event);
    const row = channelId ? rows.get(channelId) : undefined;
    if (!channelId || !row) {
      // A channel the snapshot does not know yet (just joined): ask for it.
      if (channelId && complete && !unknownChannels.has(channelId)) {
        unknownChannels.add(channelId);
        refresh([channelId]);
      }
      return;
    }
    const own = event.pubkey === viewer;
    const reference = threadReference(event);
    const rootId = reference?.rootId;
    const dm = isDm(channelId);
    const counts = dm || mentionsViewer(event);
    let next: ServerChannelRow = row;
    if (!rootId || broadcast(event)) {
      next = own
        ? {
            ...next,
            unread: false,
            mentions: 0,
            read_through_id: event.id,
            latest_id: event.id,
          }
        : {
            ...next,
            unread: true,
            mentions: Math.min(100, next.mentions + (counts ? 1 : 0)),
            latest_id: event.id,
          };
    }
    // A new root follows its author; the relay's next row lists it.
    if (own && !rootId) noteFollow(channelId, event.id, true, issue());
    if (rootId) {
      const listed = next.threads.find((thread) => thread.root_id === rootId);
      const known = followOf(channelId, rootId);
      const decides = row.followed_threads !== undefined;
      const followed = !!listed || counts || (decides && known === true);
      // Posting reads (and follows) the thread through the post.
      if (own) noteFollow(channelId, rootId, true, issue());
      else if (
        !followed &&
        (decides
          ? known === undefined
          : known === true ||
            (known === undefined && rootAuthor(rootId) === viewer))
      ) {
        // The row cannot tell, or a remembered follow may have been dropped
        // on another device: the relay's next row decides.
        probes.set(`${channelId}:${rootId}`, issue());
        ask(channelId);
      }
      const others = next.threads.filter((thread) => thread.root_id !== rootId);
      if (own && listed) next = { ...next, threads: others };
      else if (!own && followed)
        next = {
          ...next,
          threads: [
            {
              root_id: rootId,
              unread: true,
              mentions: Math.min(
                100,
                (listed?.mentions ?? 0) + (counts ? 1 : 0),
              ),
              read_through_id: listed?.read_through_id ?? null,
              latest_id: event.id,
            },
            ...others,
          ],
        };
    }
    if (next !== row) {
      writeLocally(channelId, next);
      emit();
    }
  }

  /** A ping's content: refresh just the channels it names. */
  function apply(content: string) {
    try {
      const parsed = JSON.parse(content) as {
        channels?: unknown;
        threads?: unknown;
        read_revision?: unknown;
        read_revision_from?: unknown;
      };
      const ids = new Set<string>();
      if (Array.isArray(parsed.channels))
        for (const id of parsed.channels)
          if (typeof id === "string") ids.add(id);
      if (Array.isArray(parsed.threads))
        for (const thread of parsed.threads)
          if (typeof thread?.channel_id === "string")
            ids.add(thread.channel_id);
      if (ids.size) refresh([...ids]);
      else void load(true);
      const revision = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value)
          ? value
          : undefined;
      advance(
        revision(parsed.read_revision_from),
        revision(parsed.read_revision),
      );
    } catch {
      void load();
    }
  }
  return {
    host,
    status: () => state,
    revision: () => revision,
    /** Whether a response at this read revision is older than one already seen;
     * a current one raises the mark. */
    stale(readRevision: number | undefined) {
      if (behind(readRevision)) return true;
      raise(readRevision);
      return false;
    },
    /** Whether a complete sidebar load has finished; until then rows are unknown. */
    complete: () => complete,
    row: (channelId: string) => rows.get(channelId),
    following: followOf,
    rows: () => rows,
    load,
    /** One targeted read; a full load only if the relay's revision moved
     * past what the rows reflect. */
    probe,
    refresh,
    /** A relay ping (`READ_STATE_CHANGED_KIND`) for this viewer. */
    changed(content: string, id: string) {
      if (ownPings.delete(id)) return;
      // The relay pings before answering the write that caused it: while a
      // write is in flight, wait for its answer to recognize the own echo.
      const writing = flushing;
      if (!writing) return apply(content);
      void writing.then(() => {
        if (!closed && !ownPings.delete(id)) apply(content);
      });
    },
    enqueue,
    flush,
    observe,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Optimistic local read until the relay's row replaces it. */
    readLocally(
      channelId: string,
      rootId: string | undefined,
      messageId: string,
    ) {
      const row = rows.get(channelId);
      if (!row) return;
      const next: ServerChannelRow = rootId
        ? {
            ...row,
            threads: row.threads.filter(
              (thread) =>
                thread.root_id !== rootId || thread.latest_id !== messageId,
            ),
          }
        : row.latest_id === messageId
          ? { ...row, unread: false, mentions: 0, read_through_id: messageId }
          : row;
      if (next !== row) {
        writeLocally(channelId, next);
        emit();
      }
    },
    dispose() {
      closed = true;
      lifetime.abort();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onVisibility);
      if (typeof window !== "undefined")
        window.removeEventListener("online", onOnline);
      if (repairTimer) clearTimeout(repairTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (askTimer) clearTimeout(askTimer);
      if (gapTimer) clearTimeout(gapTimer);
      if (flushTimer) clearTimeout(flushTimer);
      listeners.clear();
    },
  };
}
