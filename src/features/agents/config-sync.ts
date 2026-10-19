// Keeps the local synced copy of every bound config channel current (plan
// §4.2): live subscriptions per binding, a barrier on every connection that
// subscribes before it reads so nothing is lost between them, and one apply
// path for reads and live events alike. Dormant until config channels ship.
import { readErrorKind } from "../relay/errors";
import type { ReadFilter, RelayEvent } from "../relay/events";
import {
  ARTIFACT_KIND,
  artifactD,
  artifactProblem,
  checkedHead,
  type ArtifactType,
  type Expected,
  readCurrent,
  readHead,
  type SnapshotRead,
} from "./agent-config-artifacts";
import type { AgentConfigStore, ReadResult, Subject } from "./agent-config";
import type { ConfigFamily } from "./config-channels";

const REMOVAL_KIND = 45011;
const REDACTION_KIND = 9005;
/** Transport-failed reads retry this many times per connection, then wait for
 * the next connection or event. */
const RETRIES = 3;
const RETRY_MS = 1_000;
/** The app reader caps pages at 500 (`relay/reader.ts`), below the relay clamp. */
export const DISCOVERY_PAGE = 500;

/** Live delivery on the config route. Every filter asks for no stored events
 * (`limit: 0`): reads decide state, so `eose` only proves the subscription is
 * established on that connection. `connection` reports each new connection
 * generation; every open subscription re-establishes on it and reports `eose`
 * or `closed` with that generation. Returns the close function. */
export type ConfigFeed = Readonly<{
  read: SnapshotRead;
  relayAuthor: string;
  generation(): number;
  connection(listener: (generation: number) => void): () => void;
  subscribe(
    filters: readonly ReadFilter[],
    handlers: Readonly<{
      event(event: RelayEvent): void;
      eose(generation: number): void;
      closed(generation: number, error: string): void;
    }>,
  ): () => void;
}>;

/** One selected config channel and whose config it holds. */
export type ConfigBinding = Readonly<{
  family: ConfigFamily;
  /** The agent pubkey, or the team id. */
  subject: string;
  channel: string;
}>;

const TYPES: Record<ConfigFamily, readonly ArtifactType[]> = {
  "agent-config": ["buzz.agent.settings", "buzz.agent.instructions"],
  "team-config": ["buzz.team"],
};

type Artifact = Readonly<{ subject: Subject; expected: Expected }>;
/** One binding's lifetime. Retiring it (unbind, loss, denial, dispose) closes
 * its subscriptions and aborts its reads; nothing it started commits after. */
type Bound = {
  readonly binding: ConfigBinding;
  readonly artifacts: readonly Artifact[];
  readonly abort: AbortController;
  readonly closers: (() => void)[];
  /** Events held while a barrier reads; undefined once live. */
  buffer: RelayEvent[] | undefined;
  /** Generation → subscriptions established on it. */
  established: Map<number, number>;
  waiters: Set<() => void>;
  failed: Set<number>;
};

/** Why a binding's sync is not current. `stale`: last confirmed state is
 * kept and a retry is due; `denied`: the binding is retired. */
export type SyncProblem = Readonly<{
  channel: string;
  kind: "stale" | "denied";
  error?: string;
}>;

const tagValues = (event: RelayEvent, name: string) =>
  event.tags.flatMap(([key, value]) =>
    key === name && typeof value === "string" ? [value] : [],
  );
const tag = (event: RelayEvent, name: string) => tagValues(event, name)[0];

class Denied extends Error {}

export function createConfigSync(
  store: AgentConfigStore,
  feed: ConfigFeed,
  owner: string,
  community: string,
  listeners: Readonly<{
    /** A revision, redaction or removal changed what history shows for `d`. */
    history?(channel: string, d: string): void;
    /** Discovery saw a config channel this sync does not hold, or a bound one
     * archived or lost; the caller reselects and rebinds. */
    discovery?(metadata: RelayEvent): void;
    /** A strong rediscovery finished. `complete: false` means a full page
     * held nothing new, so channels may be missing: it adds what it found
     * but never retires or hides anything for being absent. */
    rediscovered?(complete: boolean): void;
    /** A bound channel's members changed, with the owner still in it. */
    roster?(channel: string): void;
    /** A read or subscription could not confirm the binding. */
    problem?(problem: SyncProblem): void;
  }> = {},
) {
  const bound = new Map<string, Bound>();
  const closers: (() => void)[] = [];
  const rereads = new Map<Artifact, boolean>();
  let disposed = false;
  const alive = (entry: Bound) =>
    !disposed && bound.get(entry.binding.channel) === entry;

  closers.push(
    feed.subscribe([{ kinds: [39000], "#P": [owner], limit: 0 }], {
      event: (event) => discovered(event),
      eose() {},
      closed() {},
    }),
    feed.connection((generation) => {
      void rediscover(generation);
      for (const entry of bound.values()) void barrier(entry, generation);
    }),
  );

  /** Subscribe for `bindings` not yet held, wait until those subscriptions
   * are established, then read each channel and drain what arrived meanwhile
   * through the same apply. Resolves once their barrier settles: synced, or
   * reported through `problem`. */
  async function bind(bindings: readonly ConfigBinding[]) {
    const described = await Promise.all(bindings.map(describe));
    if (disposed) return;
    // Checked after the await, so concurrent binds never hold a channel twice.
    const added = described.filter(
      (entry) => !bound.has(entry.binding.channel),
    );
    const generation = feed.generation();
    for (const entry of added) {
      bound.set(entry.binding.channel, entry);
      subscribe(entry);
    }
    await Promise.all(added.map((entry) => barrier(entry, generation)));
  }

  async function describe(binding: ConfigBinding): Promise<Bound> {
    const artifacts = await Promise.all(
      TYPES[binding.family].map(async (type) => ({
        subject: {
          owner,
          community,
          subject: binding.subject,
          channel: binding.channel,
          type,
        },
        expected: {
          channel: binding.channel,
          type,
          d: await artifactD(type, binding.channel),
          ...(binding.family === "team-config"
            ? { team: binding.subject }
            : {}),
        },
      })),
    );
    return {
      binding,
      artifacts,
      abort: new AbortController(),
      closers: [],
      buffer: [],
      established: new Map(),
      waiters: new Set(),
      failed: new Set(),
    };
  }

  function subscribe(entry: Bound) {
    const id = entry.binding.channel;
    const handlers = {
      event(event: RelayEvent) {
        if (!alive(entry)) return;
        if (entry.buffer) entry.buffer.push(event);
        else apply(entry, event);
      },
      eose(generation: number) {
        entry.established.set(
          generation,
          (entry.established.get(generation) ?? 0) + 1,
        );
        wake(entry);
      },
      closed(generation: number, error: string) {
        entry.failed.add(generation);
        wake(entry);
        if (alive(entry))
          listeners.problem?.({ channel: id, kind: "stale", error });
      },
    };
    entry.closers.push(
      feed.subscribe(
        [
          {
            kinds: [ARTIFACT_KIND, REMOVAL_KIND, REDACTION_KIND],
            "#h": [id],
            limit: 0,
          },
        ],
        handlers,
      ),
      feed.subscribe(
        [{ kinds: [39000, 39002], "#d": [id], limit: 0 }],
        handlers,
      ),
    );
  }

  function wake(entry: Bound) {
    for (const waiter of entry.waiters) waiter();
  }

  /** Both subscriptions established on `generation`, or false if that
   * connection failed, was replaced, or the binding retired first. */
  function established(entry: Bound, generation: number) {
    return new Promise<boolean>((resolve) => {
      const check = () => {
        const done =
          !alive(entry) ||
          entry.failed.has(generation) ||
          feed.generation() !== generation ||
          (entry.established.get(generation) ?? 0) >= 2;
        if (!done) return;
        entry.waiters.delete(check);
        resolve(
          alive(entry) &&
            !entry.failed.has(generation) &&
            feed.generation() === generation,
        );
      };
      entry.waiters.add(check);
      check();
    });
  }

  /** The per-connection barrier: subscriptions established, the channel
   * strongly confirmed active with the owner a member, heads read, then the
   * buffer drained. A failed step keeps the buffer for the next connection. */
  async function barrier(entry: Bound, generation: number) {
    entry.buffer ??= [];
    if (!(await established(entry, generation))) return;
    try {
      if (!(await confirm(entry))) return;
      await readChannel(entry);
    } catch (error) {
      return failure(entry, error);
    }
    if (!alive(entry) || feed.generation() !== generation) return;
    const buffer = entry.buffer ?? [];
    entry.buffer = undefined;
    for (const event of buffer) apply(entry, event);
  }

  /** Strong relay-signed metadata and roster for a bound channel. */
  async function confirm(entry: Bound) {
    const id = entry.binding.channel;
    const events = await snapshot(entry, [
      // Addressable by (kind, relay key, d): one current event each, so a
      // full page of 1 is the complete answer.
      ...[39000, 39002].map((kind) => ({
        kinds: [kind],
        authors: [feed.relayAuthor],
        "#d": [id],
        limit: 1,
        consistency: "strong" as const,
      })),
    ]);
    if (!alive(entry)) return false;
    const signed = events.filter((e) => e.pubkey === feed.relayAuthor);
    const metadata = signed.find((e) => e.kind === 39000);
    const members = signed.find((e) => e.kind === 39002);
    if (!metadata || !members) throw new Error("Config channel unconfirmed");
    for (const event of [metadata, members]) {
      roster(event);
      if (!alive(entry)) return false;
    }
    return true;
  }

  /** On each connection, strongly reread which config channels name the
   * owner, so one created while disconnected still reaches the caller. */
  async function rediscover(generation: number) {
    try {
      // The relay clamps pages, so walk back by `until` until a short page.
      const seen = new Set<string>();
      let until: number | undefined;
      for (;;) {
        const events = await feed.read(
          [
            {
              kinds: [39000],
              authors: [feed.relayAuthor],
              "#P": [owner],
              limit: DISCOVERY_PAGE,
              consistency: "strong",
              ...(until === undefined ? {} : { until }),
            },
          ],
          {},
        );
        if (disposed || feed.generation() !== generation) return;
        const fresh = events.filter((e) => !seen.has(e.id));
        for (const event of fresh) {
          seen.add(event.id);
          discovered(event);
        }
        if (events.length < DISCOVERY_PAGE)
          return listeners.rediscovered?.(true);
        // Over a page shares one `created_at`; `until` cannot step past it.
        if (fresh.length === 0) return listeners.rediscovered?.(false);
        until = Math.min(...events.map((e) => e.created_at));
      }
    } catch {
      // The next connection rediscovers; bound channels confirm themselves.
    }
  }

  /** A relay read for `entry`, aborted when it retires. A denial retires the
   * binding at once. */
  async function snapshot(entry: Bound, filters: readonly ReadFilter[]) {
    try {
      return await feed.read(filters, { signal: entry.abort.signal });
    } catch (error) {
      if (readErrorKind(error) === "denied") throw new Denied();
      throw error;
    }
  }

  /** Denial retires the binding, which blocks starts from it. Anything else
   * keeps the last confirmed state, reports stale and retries a few times. */
  function failure(entry: Bound, error: unknown) {
    if (!alive(entry)) return;
    if (error instanceof Denied) {
      unbind(entry);
      listeners.problem?.({ channel: entry.binding.channel, kind: "denied" });
      return;
    }
    listeners.problem?.({
      channel: entry.binding.channel,
      kind: "stale",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Current heads for the channel, then a deletion-preserving lookup for any
   * artifact the current read didn't return. Each result is installed only if
   * the binding is still alive and nothing changed since its capture. */
  async function readChannel(entry: Bound) {
    const captured = entry.artifacts.map(({ subject }) =>
      store.capture(subject),
    );
    const heads = await retrying(entry, () =>
      readCurrent(snapshotRead(entry), entry.binding.channel),
    );
    await Promise.all(
      entry.artifacts.map(async (artifact, index) => {
        const capture = captured[index];
        if (!capture || !alive(entry)) return;
        const head = heads?.get(artifact.expected.d);
        const result = head
          ? checkedHead(head, artifact.expected)
          : await retrying(entry, () => lookup(entry, artifact.expected));
        if (!alive(entry)) return;
        settle(
          entry,
          artifact,
          store.applyRead(artifact.subject, capture, result),
        );
      }),
    );
  }

  const snapshotRead =
    (entry: Bound): SnapshotRead =>
    (filters) =>
      snapshot(entry, filters);

  /** Bounded retries of a transport failure while the binding lives. */
  async function retrying<T>(entry: Bound, run: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof Denied || attempt >= RETRIES || !alive(entry))
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_MS * 2 ** attempt),
        );
        if (!alive(entry)) throw error;
      }
    }
  }

  async function lookup(entry: Bound, expected: Expected): Promise<ReadResult> {
    const head = await readHead(
      snapshotRead(entry),
      expected.channel,
      expected.d,
    );
    return head ? checkedHead(head, expected) : { kind: "empty" };
  }

  function settle(
    entry: Bound,
    artifact: Artifact,
    applied: ReturnType<AgentConfigStore["applyRead"]>,
  ) {
    if (applied === "reread") reread(entry, artifact);
    if (applied !== "unchanged")
      listeners.history?.(artifact.expected.channel, artifact.expected.d);
  }

  /** One fresh read per artifact at a time; a request while one is out runs
   * once more after it. Never outlives the binding that asked. */
  function reread(entry: Bound, artifact: Artifact) {
    if (rereads.has(artifact)) {
      rereads.set(artifact, true);
      return;
    }
    void (async () => {
      try {
        do {
          rereads.set(artifact, false);
          if (!alive(entry)) return;
          const capture = store.capture(artifact.subject);
          const result = await retrying(entry, () =>
            lookup(entry, artifact.expected),
          );
          if (!alive(entry)) return;
          settle(
            entry,
            artifact,
            store.applyRead(artifact.subject, capture, result),
          );
        } while (rereads.get(artifact));
      } catch (error) {
        failure(entry, error);
      } finally {
        rereads.delete(artifact);
      }
    })();
  }

  function apply(entry: Bound, event: RelayEvent) {
    if (!alive(entry)) return;
    if (event.kind === 39000 || event.kind === 39002) return roster(event);
    if (tag(event, "h") !== entry.binding.channel) return;
    if (event.kind === REDACTION_KIND) {
      const targets = tagValues(event, "e");
      for (const artifact of entry.artifacts) {
        const { generation, head } = store.state(artifact.subject);
        if (head && targets.includes(head.id))
          settle(
            entry,
            artifact,
            store.applyRedaction(artifact.subject, generation, head.id),
          );
        // An older revision's redaction changes history only.
        else if (targets.length)
          listeners.history?.(artifact.expected.channel, artifact.expected.d);
      }
      return;
    }
    const artifact = entry.artifacts.find(
      ({ expected }) => expected.d === tag(event, "d"),
    );
    if (!artifact) return;
    const { generation } = store.state(artifact.subject);
    if (event.kind === REMOVAL_KIND) {
      // Only the relay writes move markers (NIP-AR).
      if (event.pubkey !== feed.relayAuthor) return;
      return settle(
        entry,
        artifact,
        store.applyRemoval(artifact.subject, generation, tag(event, "prev")),
      );
    }
    const problem = artifactProblem(event, artifact.expected);
    settle(
      entry,
      artifact,
      store.applyLive(artifact.subject, generation, event, problem),
    );
  }

  /** Relay-signed metadata or roster for a bound channel: archived, or the
   * owner gone → every artifact in it unavailable, and the caller decides the
   * binding again. */
  function roster(event: RelayEvent) {
    if (event.pubkey !== feed.relayAuthor) return;
    const entry = bound.get(tag(event, "d") ?? "");
    if (!entry) return;
    const lost =
      event.kind === 39000
        ? event.tags.some(
            ([key, value]) => key === "archived" && value === "true",
          )
        : !tagValues(event, "p").includes(owner);
    if (!lost) {
      if (event.kind === 39002) listeners.roster?.(entry.binding.channel);
      return;
    }
    unbind(entry);
    if (event.kind === 39000) listeners.discovery?.(event);
  }

  function discovered(event: RelayEvent) {
    if (disposed || event.pubkey !== feed.relayAuthor) return;
    const id = tag(event, "d");
    if (id && bound.has(id)) return roster(event);
    listeners.discovery?.(event);
  }

  function retire(entry: Bound) {
    entry.abort.abort();
    for (const close of entry.closers.splice(0)) close();
    wake(entry);
  }

  function unbind(entry: Bound) {
    if (bound.get(entry.binding.channel) !== entry) return;
    bound.delete(entry.binding.channel);
    retire(entry);
    for (const { subject } of entry.artifacts) store.rebind(subject);
  }

  return {
    bind,
    /** Channel reselection or loss decided by the caller. */
    unbind(channel: string) {
      const entry = bound.get(channel);
      if (entry) unbind(entry);
    },
    dispose() {
      disposed = true;
      for (const entry of bound.values()) retire(entry);
      for (const close of closers.splice(0)) close();
    },
  };
}
export type ConfigSync = ReturnType<typeof createConfigSync>;
