import type { LiveSnapshot } from "../relay/live";
import type { PortSource } from "./native";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import type { EventData, ReadFilter, RelayEvent } from "../relay/events";
import { READ_RESPONSE_MAX_BYTES } from "../relay/reader";
import {
  INSTRUCTIONS_EVENT_MAX_BYTES,
  INSTRUCTIONS_KIND,
  instructionsDeletionTargets,
  instructionsSubject,
  UNKNOWN_KIND_REFUSAL,
} from "./instructions-envelope";

/** NIP-AP agent instructions (kind 44300): the single owner of this device's
 * instruction state, sync, launch resolution, saves and Delete Agent cleanup.
 * Plaintext lives only in memory; storage holds signed ciphertext events. */

export const INSTRUCTIONS_STORE_KEY = "buzz.agents.instructions.v2";
export const HAD_VERSION_KEY = "buzz.agents.instructions.had-version.v1";
export const CLEANUP_KEY = "buzz.agents.instructions.cleanup.v1";
/** The relay's timestamp window; a signed event older than this is never re-sent. */
export const RESEND_WINDOW_SECONDS = 900;
/** Versions per read: a page of maximum-size versions must fit the reader's
 * response budget, with room for its JSON framing. */
export const VERSION_PAGE = Math.floor(
  (READ_RESPONSE_MAX_BYTES * 0.9) / INSTRUCTIONS_EVENT_MAX_BYTES,
);
const DELETION_PAGE = 100;

export type Resolved =
  | Readonly<{
      source: "version" | "local" | "definition" | "legacy" | "none";
      text: string;
      versionId?: string;
    }>
  | Readonly<{ blocked: string }>;

/** What the service knows about an agent's record (kind 30177) this session. */
export type Fallback = Readonly<{
  /** The record links a definition (kind 30175). */
  linked: boolean;
  /** The linked definition's `system_prompt`; undefined when its head isn't cached. */
  definition?: string | undefined;
  /** A definition-less legacy record's `system_prompt`. */
  legacy?: string | undefined;
}>;

export type Migration =
  | Readonly<{ state: "never" }>
  | Readonly<{
      state: "staged";
      text: string;
      sourceRevision: string;
      eventId?: string;
    }>
  | Readonly<{ state: "done"; eventId: string }>;

type Head =
  | Readonly<{ event: RelayEvent }>
  | Readonly<{ absent: true; scanId: number }>
  | Readonly<{ unknown: true }>;

type Entry = Readonly<{
  head: Head;
  migration: Migration;
  /** Local text kept for the user to save, never a launch source. */
  draft?: string;
  /** When this device last saved a version (ms): sessions started before it
   * restart (§5.1). Survives app restarts, so a pinned Codex thread sees it. */
  localSave?: number;
  /** This device's last save until a scan or receipt installs its version:
   * the submitted text and its event id, kept for Save again (§2.5). */
  submitted?: Readonly<{ id: string; text: string }>;
  /** Saves replaced by Save again while still unconfirmed (§2.5): never
   * re-sent, settled when they arrive, and handed to cleanup by Delete Agent. */
  originals?: readonly string[];
}>;

type CleanupEntry = Readonly<{
  owner: string;
  canonicalCommunity: string;
  id: string;
}>;

export const subjectKey = (owner: string, community: string, agent: string) =>
  `${owner}:${community}:${agent}`;
export const recoveryKey = (owner: string, community: string, agent: string) =>
  `instructions:${subjectKey(owner, community, agent)}`;

type Decoded = Readonly<{ text: string } | { invalid: string }>;

/** §3: a create or import written before the native call, so a crash after
 * the native commit can finish from what it was asked to do. */
export type AgentIntent = Readonly<
  {
    intentId: string;
    owner: string;
    community: string;
    type: string;
  } & (
    | {
        mode: "create";
        text?: string;
        config?: unknown;
        picture?: string;
      }
    | { mode: "import"; source: PortSource; pubkey: string }
  )
>;

/** Device storage for instruction state. Owner-scoped: every read goes through
 * the current owner's key, and sign-out clears that owner's entries only. */
export class InstructionStore {
  private entries = new Map<string, Entry>();
  private had = new Set<string>();
  private cleanup: CleanupEntry[] = [];
  /** Complete scans per `owner:community`; a subject without a version then
   * resolves as absent. */
  private scans = new Map<string, number>();
  private intents = new Map<string, AgentIntent>();
  /** `owner:community` pairs whose relay explicitly refused kind 44300 (§3). */
  private unsupported = new Set<string>();
  /** In memory only, re-derived through native decode. */
  private decoded = new Map<string, Decoded>();
  private listeners = new Set<() => void>();
  private revision = 0;

  constructor(private storage: Pick<Storage, "getItem" | "setItem">) {
    const store = parse(storage.getItem(INSTRUCTIONS_STORE_KEY)) as
      | {
          entries?: Record<string, unknown>;
          scans?: Record<string, unknown>;
          intents?: Record<string, unknown>;
          unsupported?: unknown;
        }
      | undefined;
    for (const [key, value] of Object.entries(store?.entries ?? {}))
      if (validEntry(value)) this.entries.set(key, value);
    for (const [key, value] of Object.entries(store?.scans ?? {}))
      if (typeof value === "number") this.scans.set(key, value);
    for (const [key, value] of Object.entries(store?.intents ?? {}))
      if (validIntent(value) && value.intentId === key)
        this.intents.set(key, value);
    if (Array.isArray(store?.unsupported))
      for (const key of store.unsupported)
        if (typeof key === "string") this.unsupported.add(key);
    const had = parse(storage.getItem(HAD_VERSION_KEY));
    if (Array.isArray(had))
      for (const key of had) if (typeof key === "string") this.had.add(key);
    const cleanup = parse(storage.getItem(CLEANUP_KEY));
    if (Array.isArray(cleanup))
      this.cleanup = cleanup.filter(
        (item): item is CleanupEntry =>
          !!item &&
          typeof item.owner === "string" &&
          typeof item.canonicalCommunity === "string" &&
          typeof item.id === "string",
      );
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  snapshot() {
    return this.revision;
  }
  /** Notifies readers of in-memory subject state (e.g. pendingDeletion). */
  touch() {
    this.changed();
  }
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  entry(key: string): Entry | undefined {
    return this.entries.get(key);
  }
  decodedText(id: string) {
    return this.decoded.get(id);
  }
  remember(id: string, value: Decoded) {
    this.decoded.set(id, value);
  }
  scanned(owner: string, community: string) {
    return this.scans.get(`${owner}:${community}`);
  }
  /** Agents with an entry under this owner and community. */
  agents(owner: string, community: string) {
    const prefix = `${owner}:${community}:`;
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
  hadVersion(key: string) {
    return this.had.has(key);
  }
  refusesHistory(owner: string, community: string) {
    return this.unsupported.has(`${owner}:${community}`);
  }
  /** §3: the relay refused kind 44300 itself, not auth or a transient error. */
  markRefusesHistory(owner: string, community: string) {
    const key = `${owner}:${community}`;
    if (!this.unsupported.has(key))
      this.commit(() => this.unsupported.add(key));
  }

  write(key: string, entry: Entry) {
    this.commit(() => this.entries.set(key, entry));
  }
  /** §3: keeps text written at create, import or migration as launchable local
   * text until its first version is confirmed. Never over an earlier stage. */
  stage(key: string, text: string, sourceRevision: string) {
    const entry = this.entries.get(key);
    if (entry && entry.migration.state !== "never") return;
    this.write(key, {
      ...(entry ?? { head: { unknown: true } }),
      migration: { state: "staged", text, sourceRevision },
    });
  }
  markLocalSave(key: string, at: number) {
    const entry = this.entries.get(key) ?? {
      head: { unknown: true },
      migration: { state: "never" },
    };
    this.write(key, { ...entry, localSave: nextLocalSave(entry, at) });
  }
  completeScan(owner: string, community: string, scanId: number) {
    this.commit(() => this.scans.set(`${owner}:${community}`, scanId));
  }
  markHadVersion(key: string) {
    if (this.had.has(key)) return;
    this.storage.setItem(HAD_VERSION_KEY, JSON.stringify([...this.had, key]));
    this.had.add(key);
    this.changed();
  }
  /** Delete Agent step 5: the subject's entries and its had-version key. */
  forget(key: string) {
    if (this.had.has(key)) {
      const had = [...this.had].filter((item) => item !== key);
      this.storage.setItem(HAD_VERSION_KEY, JSON.stringify(had));
      this.had.delete(key);
    }
    this.commit(() => this.entries.delete(key));
  }
  /** §2.2 sign-out: native sign-out restarts the app, so the next start drops
   * every other owner's entries and scans (all of them when nobody is signed
   * in); had-version keys and cleanup stay. */
  keepOwner(owner?: string) {
    const others = (keys: Iterable<string>) =>
      [...keys].filter((key) => !owner || !key.startsWith(`${owner}:`));
    const entries = others(this.entries.keys());
    const scans = others(this.scans.keys());
    const unsupported = others(this.unsupported);
    if (!entries.length && !scans.length && !unsupported.length) return;
    this.commit(() => {
      for (const key of entries) this.entries.delete(key);
      for (const key of scans) this.scans.delete(key);
      for (const key of unsupported) this.unsupported.delete(key);
    });
  }

  intent(intentId: string) {
    return this.intents.get(intentId);
  }
  /** Throws when storage fails, so the native call is never made. */
  putIntent(intent: AgentIntent) {
    this.commit(() => this.intents.set(intent.intentId, intent));
  }
  dropIntent(intentId: string) {
    if (this.intents.has(intentId))
      this.commit(() => this.intents.delete(intentId));
  }

  cleanupIds(owner: string, community: string) {
    return this.cleanup
      .filter(
        (item) => item.owner === owner && item.canonicalCommunity === community,
      )
      .map((item) => item.id);
  }
  /** Throws when storage fails, so the caller keeps its outbox entry. */
  addCleanup(owner: string, community: string, id: string) {
    if (this.cleanupIds(owner, community).includes(id)) return;
    const next = [
      ...this.cleanup,
      { owner, canonicalCommunity: community, id },
    ];
    this.storage.setItem(CLEANUP_KEY, JSON.stringify(next));
    this.cleanup = next;
  }
  dropCleanup(owner: string, community: string, id: string) {
    const next = this.cleanup.filter(
      (item) =>
        !(
          item.owner === owner &&
          item.canonicalCommunity === community &&
          item.id === id
        ),
    );
    this.storage.setItem(CLEANUP_KEY, JSON.stringify(next));
    this.cleanup = next;
  }

  /** Memory changes only once storage holds them; a failed write restores
   * what readers saw before and throws. */
  private commit(apply: () => void) {
    const before = [
      new Map(this.entries),
      new Map(this.scans),
      new Map(this.intents),
      new Set(this.unsupported),
    ] as const;
    apply();
    try {
      this.persist();
    } catch (error) {
      [this.entries, this.scans, this.intents, this.unsupported] = before;
      throw error;
    }
  }
  private persist() {
    this.storage.setItem(
      INSTRUCTIONS_STORE_KEY,
      JSON.stringify({
        entries: Object.fromEntries(this.entries),
        scans: Object.fromEntries(this.scans),
        intents: Object.fromEntries(this.intents),
        unsupported: [...this.unsupported],
      }),
    );
    this.changed();
  }
}

/** A later local-save generation than the entry's, never behind the clock. */
const nextLocalSave = (entry: Entry, at: number) =>
  Math.max(at, (entry.localSave ?? 0) + 1);

function parse(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
function validEntry(value: unknown): value is Entry {
  const v = value as { head?: object; migration?: { state?: unknown } } | null;
  return (
    typeof v === "object" &&
    !!v?.head &&
    ("event" in v.head || "absent" in v.head || "unknown" in v.head) &&
    ["never", "staged", "done"].includes(v.migration?.state as string)
  );
}

function validIntent(value: unknown): value is AgentIntent {
  const v = value as Record<string, unknown> | null;
  if (typeof v !== "object" || !v) return false;
  if (
    !["intentId", "owner", "community", "type"].every(
      (field) => typeof v[field] === "string",
    )
  )
    return false;
  if (v.mode === "create")
    return v.text === undefined || typeof v.text === "string";
  return (
    v.mode === "import" &&
    typeof v.pubkey === "string" &&
    ["harness", "installed", "development"].includes(v.source as string)
  );
}

/** §2.4: synchronous, store-only launch resolution in NIP-AP order. */
export function resolveInstructions(
  store: InstructionStore,
  owner: string,
  community: string,
  agent: string,
  fallback: Fallback | undefined,
  pendingDeletion = false,
): Resolved {
  const key = subjectKey(owner, community, agent);
  const entry = store.entry(key);
  if (pendingDeletion)
    return {
      blocked:
        "Instructions changed on another device; loading the current version",
    };
  const head = entry?.head;
  if (head && "event" in head) {
    const decoded = store.decodedText(head.event.id);
    if (!decoded) return { blocked: "Instructions haven't synced yet" };
    if ("invalid" in decoded) return { blocked: decoded.invalid };
    return { source: "version", text: decoded.text, versionId: head.event.id };
  }
  const absent =
    (head && "absent" in head) ||
    ((!head || !("unknown" in head)) &&
      store.scanned(owner, community) !== undefined);
  const migration = entry?.migration;
  if (localOnly(store, owner, community, agent))
    return {
      source: "local",
      text: migration?.state === "staged" ? migration.text : "",
    };
  if (!absent) return { blocked: "Instructions haven't synced yet" };
  if (!store.hadVersion(key) && migration?.state === "staged")
    return { source: "local", text: migration.text };
  if (!fallback) return { blocked: "Agent record not synced" };
  if (fallback.linked)
    return fallback.definition === undefined
      ? { blocked: "Definition not synced" }
      : { source: "definition", text: fallback.definition };
  if (fallback.legacy !== undefined)
    return { source: "legacy", text: fallback.legacy };
  return { source: "none", text: "" };
}

/** §3: before this community's first complete scan, or while its relay
 * explicitly refuses kind 44300, configured local text that never had a
 * version stays the agent's instructions and is edited in place ("History
 * isn't available yet"); a new device has none and waits. */
export function localOnly(
  store: InstructionStore,
  owner: string,
  community: string,
  agent: string,
) {
  const key = subjectKey(owner, community, agent);
  return (
    (store.scanned(owner, community) === undefined ||
      store.refusesHistory(owner, community)) &&
    !store.hadVersion(key) &&
    store.entry(key)?.migration.state === "staged"
  );
}

/** Editor save state, derived only from the outbox entry and the clock. */
export type SaveState =
  | Readonly<{ state: "saving" }>
  | Readonly<{ state: "stored" }>
  | Readonly<{ state: "uncertain"; reason?: string; expired: boolean }>
  | Readonly<{ state: "rejected"; reason: string }>;

/** §2.5 Recovery: only a refused first send with nothing earlier in doubt is a
 * rejection; the outbox keeps an earlier `unknown` across a refused retry. */
const expired = (entry: OutgoingEvent, now: number) =>
  now > (entry.signed ?? entry.event).created_at + RESEND_WINDOW_SECONDS;

/** Only a refused save, or one still unconfirmed after the window, may be
 * replaced by a new event, and only by the user's explicit save. */
const replaceable = (state: SaveState) =>
  state.state === "rejected" || (state.state === "uncertain" && state.expired);

export function saveState(entry: OutgoingEvent, now: number): SaveState {
  switch (entry.delivery) {
    case "accepted":
    case "seen":
      return { state: "stored" };
    case "sending":
      return { state: "saving" };
    case "failed":
      return { state: "rejected", reason: entry.error ?? "Refused" };
    case "unknown":
      return {
        state: "uncertain",
        ...(entry.error ? { reason: entry.error } : {}),
        expired: expired(entry, now),
      };
  }
}

export type IdentityState = "loading" | "failed" | "ready";
export type Inventory = Readonly<{
  state: IdentityState;
  /** Native rows plus legitimate relay-listed agents for this owner and community. */
  known: ReadonlySet<string>;
  /** Native rows this device deleted. */
  deleted: ReadonlySet<string>;
}>;

export type InstructionCodec = {
  prepare(subject: string, text: string): Promise<string>;
  decode(
    subject: string,
    events: readonly RelayEvent[],
  ): Promise<readonly ({ id: string } & Decoded)[]>;
};

export type InstructionPorts = Readonly<{
  owner: string;
  community: string;
  signal: AbortSignal;
  store: InstructionStore;
  codec: InstructionCodec;
  read(
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly RelayEvent[]>;
  outbox: Outbox | undefined;
  live: Readonly<{
    snapshot(): LiveSnapshot;
    subscribe(listener: () => void): () => void;
  }>;
  subscribeLive(
    listener: (batch: Readonly<{ events: readonly RelayEvent[] }>) => void,
  ): () => void;
  admitDeletions(holds: (id: string) => boolean): () => void;
  now(): number;
}>;

type Subject = {
  versions: Map<string, RelayEvent>;
  deleted: Set<string>;
  /** Changes on every change to `versions` or `deleted`: an install decided
   * at an older revision never commits. */
  revision: number;
  pendingDeletion: boolean;
};
type Token = Readonly<{ n: number }>;

export class ConflictError extends Error {
  constructor(readonly head: string | undefined) {
    super("Changed on another device");
  }
}

const newer = (a: EventData, b: EventData) =>
  a.created_at !== b.created_at ? a.created_at > b.created_at : a.id < b.id;

/** The relay's answer when it does not accept a kind at all (§3). */
const refusesKind = (state: SaveState) =>
  state.state === "rejected" && state.reason.endsWith(UNKNOWN_KIND_REFUSAL);

/** One binding's instructions sync: scan tokens, live merge, saves, recovery,
 * the Delete Agent sweep and the cleanup list. Dropped with its binding.
 *
 * Every writer of an agent's entry or installed head commits only after its
 * last await, and only if the binding, the agent's eligibility, its registered
 * subject and that subject's revision are all still what it started from. */
export class InstructionSync {
  private subjects = new Map<string, Subject>();
  private token: Token | undefined;
  private tokens = 0;
  /** The current scan's returned version ids, admitted for deletions before
   * they are merged into subjects. Owned by that scan's token. */
  private scanned: Readonly<{ token: Token; ids: Set<string> }> | undefined;
  /** One set per running reconcile (full scan or subject read): versions
   * learned elsewhere since it began, which it keeps even if its read missed
   * them. */
  private reconciling = new Set<Set<string>>();
  private inventory: Inventory = {
    state: "loading",
    known: new Set(),
    deleted: new Set(),
  };
  private fenced = new Set<string>();
  private stops: (() => void)[] = [];
  private migrating: Promise<void> = Promise.resolve();

  constructor(private ports: InstructionPorts) {}

  private get alive() {
    return !this.ports.signal.aborted;
  }
  private key(agent: string) {
    return subjectKey(this.ports.owner, this.ports.community, agent);
  }
  private subject(agent: string) {
    let value = this.subjects.get(agent);
    if (!value) {
      value = {
        versions: new Map(),
        deleted: new Set(),
        revision: 0,
        pendingDeletion: false,
      };
      this.subjects.set(agent, value);
    }
    return value;
  }
  /** Adds a candidate version; every running reconcile but `from` keeps it. */
  private learn(s: Subject, event: RelayEvent, from?: Set<string>) {
    if (s.versions.has(event.id)) return false;
    s.versions.set(event.id, event);
    s.revision++;
    for (const seen of this.reconciling) if (seen !== from) seen.add(event.id);
    return true;
  }
  /** A reconcile keeps only what its read returned, plus what was learned
   * elsewhere since it began. */
  private reconcile(s: Subject, returned: Set<string>, since: Set<string>) {
    for (const id of [...s.versions.keys()])
      if (!returned.has(id) && !since.has(id)) {
        s.versions.delete(id);
        s.revision++;
      }
  }
  /** Writes the agent's entry only while it exists and may still change. */
  private update(agent: string, change: (entry: Entry) => Entry) {
    const key = this.key(agent);
    const entry = this.ports.store.entry(key);
    if (!entry || !this.alive || !this.eligible(agent)) return false;
    this.ports.store.write(key, change(entry));
    return true;
  }

  start() {
    const { live, subscribeLive, admitDeletions } = this.ports;
    this.stops.push(
      admitDeletions((id) => this.admits(id)),
      live.subscribe(() => this.observe()),
      subscribeLive(({ events }) => void this.receive(events)),
      ...(this.ports.outbox
        ? [this.ports.outbox.subscribe(() => this.delivered())]
        : []),
    );
    this.ports.signal.addEventListener("abort", () => this.stop(), {
      once: true,
    });
    void this.hydrate();
    this.observe();
  }
  stop() {
    this.token = undefined;
    for (const stop of this.stops.splice(0)) stop();
  }

  /** A deletion may target any version this device knows: in a subject, in
   * the current scan, or a cached head. */
  private admits(id: string) {
    if (this.scanned?.token === this.token && this.scanned?.ids.has(id))
      return true;
    if ([...this.subjects.values()].some((s) => s.versions.has(id)))
      return true;
    const { store, owner, community } = this.ports;
    return store.agents(owner, community).some((agent) => {
      const head = store.entry(this.key(agent))?.head;
      return !!head && "event" in head && head.event.id === id;
    });
  }

  /** §2.1: cached heads go back through native decode at start, so launch
   * works from the cache while the relay is down. A head that fails
   * verification drops to unknown; a decode that throws changes nothing. */
  private async hydrate() {
    const { store, owner, community, codec } = this.ports;
    for (const agent of store.agents(owner, community)) {
      const key = this.key(agent);
      const head = store.entry(key)?.head;
      if (!head || !("event" in head) || store.decodedText(head.event.id))
        continue;
      const { event } = head;
      const rows = await codec.decode(agent, [event]).catch(() => undefined);
      if (!this.alive) return;
      const latest = store.entry(key);
      if (!rows || !latest || !("event" in latest.head)) continue;
      if (latest.head.event.id !== event.id) continue;
      const [row] = rows;
      if (row?.id === event.id)
        store.remember(
          event.id,
          "text" in row ? { text: row.text } : { invalid: row.invalid },
        );
      else
        this.update(agent, (entry) => ({ ...entry, head: { unknown: true } }));
    }
    store.touch();
  }

  /** §2.3: a fresh token on each entry of the route into `live`; any exit
   * invalidates it. */
  private observe() {
    if (!this.alive) return;
    const snapshot = this.ports.live.snapshot();
    const route = snapshot.routes.find((item) => item.id === "instructions");
    const live = snapshot.status === "connected" && route?.status === "live";
    if (!live) {
      this.token = undefined;
      return;
    }
    if (this.token) return;
    const token = { n: ++this.tokens };
    this.token = token;
    void this.scan(token).catch(() => {});
  }
  private current(token: Token) {
    return this.alive && this.token === token;
  }

  /** §2.7 "Late versions": only a subject this device deleted drops events,
   * and once inventory is ready, one that no longer belongs to it. */
  private eligible(agent: string) {
    const { state, known, deleted } = this.inventory;
    if (deleted.has(agent) || this.fenced.has(agent)) return false;
    return state !== "ready" || known.has(agent);
  }

  /** Inventory updates; an identity that becomes known gets a direct read. */
  identities(next: Inventory) {
    const before = this.inventory;
    this.inventory = next;
    for (const agent of next.deleted) this.fenced.add(agent);
    const token = this.token;
    if (!token || next.state !== "ready") return;
    for (const agent of next.known)
      if (!(before.state === "ready" && before.known.has(agent)))
        void this.readSubject(agent, token).catch(() => {});
  }

  private async page(
    filter: ReadFilter,
    token: Token | undefined,
  ): Promise<RelayEvent[]> {
    const out = new Map<string, RelayEvent>();
    let cursor: { until: number; before_id: string } | undefined;
    for (;;) {
      if (token && !this.current(token)) throw new Error("Scan superseded");
      const page = await this.ports.read(
        [{ ...filter, consistency: "strong", ...cursor }],
        this.ports.signal,
      );
      const fresh = page.filter((event) => !out.has(event.id));
      if (!fresh.length) return [...out.values()];
      for (const event of fresh) out.set(event.id, event);
      const oldest = fresh.reduce((a, b) => (newer(a, b) ? b : a));
      cursor = { until: oldest.created_at, before_id: oldest.id };
    }
  }

  private versionsFilter(agent?: string): ReadFilter {
    return {
      kinds: [INSTRUCTIONS_KIND],
      authors: [this.ports.owner],
      ...(agent ? { "#p": [agent] } : {}),
      limit: VERSION_PAGE,
    };
  }
  private deletionsFilter(): ReadFilter {
    return {
      kinds: [5],
      authors: [this.ports.owner],
      "#k": [String(INSTRUCTIONS_KIND)],
      limit: DELETION_PAGE,
    };
  }

  /** §2.3 full scan: versions then deletions, each to an empty page. Only a
   * complete scan under the current token writes. */
  private async scan(token: Token) {
    const since = new Set<string>();
    this.reconciling.add(since);
    try {
      const versions = await this.page(this.versionsFilter(), token);
      const scanned = new Map<string, RelayEvent[]>();
      const ids = new Set<string>();
      for (const event of versions) {
        const agent = instructionsSubject(event.tags);
        if (!agent || event.pubkey !== this.ports.owner) continue;
        scanned.set(agent, [...(scanned.get(agent) ?? []), event]);
        ids.add(event.id);
      }
      this.scanned = { token, ids };
      const deletions = await this.page(this.deletionsFilter(), token);
      if (!this.current(token)) return;
      // Authoritative: what the scan didn't return, and nothing re-established
      // since it began, is gone (§2.3 full-scan reconciliation).
      for (const s of this.subjects.values()) this.reconcile(s, ids, since);
      for (const [agent, events] of scanned) {
        if (!this.eligible(agent)) continue;
        const s = this.subject(agent);
        for (const event of events) this.learn(s, event, since);
      }
      for (const deletion of deletions) this.applyDeletion(deletion, false);
      const scanId = token.n;
      for (const agent of new Set([
        ...scanned.keys(),
        ...this.subjects.keys(),
        ...this.ports.store.agents(this.ports.owner, this.ports.community),
      ])) {
        await this.installCurrent(agent, token, scanId);
      }
      // Complete only once every subject's current revision is installed, so
      // a subject never resolves through the fallback while a decode is held.
      // A failed decode throws and leaves the scan incomplete.
      if (!this.current(token)) return;
      this.ports.store.completeScan(
        this.ports.owner,
        this.ports.community,
        scanId,
      );
    } finally {
      this.reconciling.delete(since);
      if (this.scanned?.token === token) this.scanned = undefined;
    }
    await this.recover(token);
    await this.sweepCleanup();
  }

  /** §2.3 "Identity becomes known" and head-deletion re-reads: reconciled
   * like the full scan, for one subject. */
  private async readSubject(agent: string, token: Token) {
    if (!this.eligible(agent)) return;
    const s = this.subject(agent);
    const since = new Set<string>();
    this.reconciling.add(since);
    try {
      const versions = (
        await this.page(this.versionsFilter(agent), token)
      ).filter((event) => instructionsSubject(event.tags) === agent);
      const deletions = await this.page(this.deletionsFilter(), token);
      if (
        !this.current(token) ||
        !this.eligible(agent) ||
        this.subjects.get(agent) !== s
      )
        return;
      this.reconcile(s, new Set(versions.map((event) => event.id)), since);
      for (const event of versions) this.learn(s, event, since);
      for (const deletion of deletions) this.applyDeletion(deletion, false);
    } finally {
      this.reconciling.delete(since);
    }
    await this.installCurrent(agent, token);
  }

  private applyDeletion(event: RelayEvent, live: boolean) {
    if (event.pubkey !== this.ports.owner) return;
    for (const id of instructionsDeletionTargets(event) ?? [])
      for (const [agent, s] of this.subjects) {
        if (!s.versions.has(id) || s.deleted.has(id)) continue;
        s.deleted.add(id);
        s.revision++;
        const head = this.ports.store.entry(this.key(agent))?.head;
        if (head && "event" in head && head.event.id === id) {
          s.pendingDeletion = true;
          this.ports.store.touch();
          if (live && this.token)
            void this.readSubject(agent, this.token).catch(() => {});
        }
      }
  }

  /** Installs the subject's current revision, starting over whenever a newer
   * revision supersedes the install in flight. True once a head is committed;
   * false if the token or the agent's eligibility ends first. */
  private async installCurrent(agent: string, token: Token, scanId?: number) {
    while (this.current(token) && this.eligible(agent)) {
      const s = this.subjects.get(agent) ?? this.subject(agent);
      if (await this.install(agent, s.revision, token, scanId)) return true;
    }
    return false;
  }

  /** Installs the newest undeleted version as head, decoding it first. True
   * only if it committed: a superseded or fenced install writes nothing. */
  private async install(
    agent: string,
    revision: number,
    token: Token,
    scanId?: number,
  ): Promise<boolean> {
    const s = this.subjects.get(agent);
    const fresh = () =>
      this.current(token) &&
      this.eligible(agent) &&
      this.subjects.get(agent) === s &&
      s?.revision === revision;
    if (!s || !fresh()) return false;
    const key = this.key(agent);
    let best: RelayEvent | undefined;
    for (const event of s.versions.values())
      if (!s.deleted.has(event.id) && (!best || newer(event, best)))
        best = event;
    if (best && !this.ports.store.decodedText(best.id)) {
      const [row] = await this.ports.codec.decode(agent, [best]);
      if (!fresh()) return false;
      if (row?.id === best.id)
        this.ports.store.remember(
          best.id,
          "text" in row ? { text: row.text } : { invalid: row.invalid },
        );
    }
    if (!fresh()) return false;
    const entry = this.ports.store.entry(key) ?? {
      head: { unknown: true } as const,
      migration: { state: "never" } as const,
    };
    if (s.versions.size) this.ports.store.markHadVersion(key);
    s.pendingDeletion = false;
    const head: Head = best
      ? { event: best }
      : { absent: true, scanId: scanId ?? token.n };
    // This device's save is confirmed once its version is installed, and only
    // then restarts the agent's sessions, onto this head (§5.1). A replaced
    // original that arrived is settled: it is a version like any other.
    const { submitted, originals, ...rest } = entry;
    const confirmed = submitted && s.versions.has(submitted.id);
    const unsettled = originals?.filter((id) => !s.versions.has(id));
    this.ports.store.write(key, {
      ...rest,
      head,
      ...(confirmed
        ? { localSave: nextLocalSave(entry, Date.now()) }
        : submitted && { submitted }),
      ...(unsettled?.length && { originals: unsettled }),
    });
    return true;
  }

  /** Delivery changed: a save the relay accepted is received like any version. */
  private delivered() {
    const prefix = `instructions:${this.ports.owner}:${this.ports.community}:`;
    const stored = (this.ports.outbox?.snapshot() ?? []).flatMap((item) =>
      item.recovery?.key.startsWith(prefix) &&
      item.signed &&
      (item.delivery === "accepted" || item.delivery === "seen")
        ? [item.signed]
        : [],
    );
    // The entry stays as Delete Agent's proof until an echo or scan retires it.
    if (stored.length) void this.receive(stored, false);
    this.ports.store.touch();
  }

  private async receive(events: readonly RelayEvent[], settle = true) {
    for (const event of events) {
      if (event.pubkey !== this.ports.owner) continue;
      if (event.kind === INSTRUCTIONS_KIND) {
        const agent = instructionsSubject(event.tags);
        if (!agent || !this.eligible(agent)) continue;
        const s = this.subject(agent);
        if (!this.learn(s, event)) continue;
        this.ports.store.markHadVersion(this.key(agent));
        const token = this.token;
        if (token) await this.install(agent, s.revision, token).catch(() => {});
        if (settle) await this.settleSaved(event.id);
      } else if (event.kind === 5) this.applyDeletion(event, true);
    }
  }

  pendingDeletion(agent: string) {
    return this.subjects.get(agent)?.pendingDeletion ?? false;
  }
  history(agent: string) {
    const s = this.subjects.get(agent);
    return s
      ? [...s.versions.values()]
          .filter((event) => !s.deleted.has(event.id))
          .sort((a, b) => (newer(a, b) ? -1 : 1))
      : [];
  }

  /** The outbox entry of this agent's unfinished save, if any. */
  pendingSave(agent: string) {
    const key = recoveryKey(this.ports.owner, this.ports.community, agent);
    return this.ports.outbox
      ?.snapshot()
      .find((item) => item.recovery?.key === key);
  }

  /** §2.6: prepare, check the head, publish. Returns the new event id. An
   * earlier save that was refused, or couldn't be confirmed after the resend
   * window, is replaced only by this explicit save (Save again, §2.5). */
  async save(agent: string, text: string, base: string | undefined) {
    const { outbox, codec, owner, community, signal, store } = this.ports;
    if (!this.eligible(agent)) throw new Error("This agent was deleted");
    if (!outbox) throw new Error("This community can't save instructions");
    await outbox.ready();
    const earlier = this.pendingSave(agent);
    const earlierState = earlier && saveState(earlier, this.ports.now());
    // Anything else is left to the outbox: a stored entry stays as Delete
    // Agent's proof until its echo retires it.
    const replacing =
      earlierState && replaceable(earlierState) ? earlier : undefined;
    const content = await codec.prepare(agent, text);
    signal.throwIfAborted();
    const [head] = await this.ports.read(
      [{ ...this.versionsFilter(agent), limit: 1, consistency: "strong" }],
      signal,
    );
    if ((head?.id ?? undefined) !== base) throw new ConflictError(head?.id);
    if (!this.eligible(agent)) throw new Error("This agent was deleted");
    const key = this.key(agent);
    const blank: Entry = {
      head: { unknown: true },
      migration: { state: "never" },
    };
    if (replacing) {
      // An unconfirmed original may still land: kept durably before its
      // outbox entry goes, so a late arrival settles and Delete Agent cleans it.
      if (earlierState?.state === "uncertain") {
        const entry = store.entry(key) ?? blank;
        store.write(key, {
          ...entry,
          originals: [...(entry.originals ?? []), replacing.event.id],
        });
      }
      await outbox.retire(replacing.event.id);
      if (!this.eligible(agent)) throw new Error("This agent was deleted");
    }
    const id = outbox.send(
      {
        kind: INSTRUCTIONS_KIND,
        content,
        tags: [["p", agent]],
        ...(head ? { supersedes: head.created_at } : {}),
      },
      {
        key: recoveryKey(owner, community, agent),
        value: JSON.stringify({ base: base ?? null, draftHash: hash(text) }),
      },
      () => this.alive && this.eligible(agent),
    );
    const entry = store.entry(key) ?? blank;
    // The kept local draft lives on as the submitted text once it is saved.
    const { draft, ...rest } = entry;
    store.write(key, {
      ...(draft === text ? rest : entry),
      submitted: { id, text },
    });
    return id;
  }

  /** A save the relay is known to hold leaves the outbox. */
  private async settleSaved(id: string) {
    const outbox = this.ports.outbox;
    const item = outbox?.snapshot().find((entry) => entry.event.id === id);
    if (outbox && item?.recovery?.key.startsWith("instructions:"))
      await outbox.retire(id);
  }

  /** §2.5 Recovery for this owner and community: inside the window the same
   * signed bytes are re-sent; after it the native writer reads by exact id and
   * never re-sends. A save the relay holds is received before it is retired. */
  async recover(token?: Token) {
    const outbox = this.ports.outbox;
    if (!outbox) return;
    const prefix = `instructions:${this.ports.owner}:${this.ports.community}:`;
    for (const item of outbox.snapshot()) {
      if (!item.recovery?.key.startsWith(prefix)) continue;
      if (token && !this.current(token)) return;
      const agent = item.recovery.key.slice(prefix.length);
      if (!this.eligible(agent)) continue; // Fenced: only settle may act.
      const held = this.subjects.get(agent)?.versions.has(item.event.id);
      if (held || item.delivery === "accepted" || item.delivery === "seen")
        await outbox.retire(item.event.id);
      else if (item.delivery !== "unknown") continue;
      else if (!expired(item, this.ports.now()))
        outbox.retry(item.event.id, () => this.alive && this.eligible(agent));
      else {
        const found = await this.find(item.event.id);
        const live = token ?? this.token;
        if (!found || !live || !this.current(live) || !this.eligible(agent))
          continue;
        // The signed save leaves the outbox only once it is installed and its
        // submitted state resolved; a deferred, discarded or failed install
        // keeps it for the next recovery.
        const s = this.subject(agent);
        if (this.learn(s, found))
          this.ports.store.markHadVersion(this.key(agent));
        if (await this.installCurrent(agent, live).catch(() => false))
          await outbox.retire(item.event.id);
      }
    }
  }

  /** After the window: an exact-id read, never a re-send. */
  private async find(id: string) {
    const [found] = await this.ports.read(
      [
        {
          kinds: [INSTRUCTIONS_KIND],
          authors: [this.ports.owner],
          ids: [id],
          limit: 1,
          consistency: "strong",
        },
      ],
      this.ports.signal,
    );
    return found?.id === id ? found : undefined;
  }

  /** §2.7 Delete Agent, steps 1–5. Throws on any failure; the caller's cleanup
   * loop retries from step 1. Fencing first makes every install, migration
   * step and save still in flight for this agent discard its result. */
  async deleteAgent(agent: string) {
    const { outbox, owner, community, store, signal } = this.ports;
    this.fenced.add(agent);
    const key = this.key(agent);
    const entry = store.entry(key);
    // Replaced originals may still land: durable cleanup before anything else.
    for (const id of entry?.originals ?? [])
      store.addCleanup(owner, community, id);
    if (entry?.migration.state === "staged")
      store.write(key, { ...entry, migration: { state: "never" } });
    if (!outbox) throw new Error("This community can't delete instructions");
    await outbox.ready();
    const recovery = recoveryKey(owner, community, agent);
    const deletions: string[] = [];
    for (const item of outbox.snapshot()) {
      if (item.recovery?.key !== recovery) continue;
      const id = item.event.id;
      const settled = await outbox.settle(id);
      if (settled === "stored") deletions.push(id);
      else if (settled === "uncertain")
        // Durable before retirement: a failed write keeps the outbox entry.
        store.addCleanup(owner, community, id);
      await outbox.retire(id);
    }
    signal.throwIfAborted();
    const sweep = async () =>
      (await this.page(this.versionsFilter(agent), undefined)).filter(
        (event) => instructionsSubject(event.tags) === agent,
      );
    const targets = new Set([
      ...deletions,
      ...(await sweep()).map((e) => e.id),
    ]);
    for (const id of targets) await this.deleteVersion(id);
    if ((await sweep()).length) throw new Error("Instruction versions remain");
    this.subjects.delete(agent);
    store.forget(key);
  }

  /** One kind 5 for an exact 44300 id, awaited to acceptance. */
  private async deleteVersion(id: string) {
    const outbox = this.ports.outbox;
    if (!outbox) throw new Error("This community can't delete instructions");
    const sent = outbox.send(
      {
        kind: 5,
        content: "",
        tags: [
          ["e", id],
          ["k", String(INSTRUCTIONS_KIND)],
        ],
      },
      undefined,
      () => this.alive,
    );
    await accepted(outbox, sent, this.ports.signal);
    await outbox.dismiss(sent);
  }

  /** §2.7 cleanup list: every sync, independent of deleted native rows. */
  async sweepCleanup() {
    const { owner, community, store } = this.ports;
    const ids = store.cleanupIds(owner, community);
    if (!ids.length || !this.ports.outbox) return;
    // Cleanup IDs never expire, so read them in pages the reader accepts.
    for (let at = 0; at < ids.length; at += VERSION_PAGE) {
      const batch = ids.slice(at, at + VERSION_PAGE);
      const found = await this.ports.read(
        [
          {
            kinds: [INSTRUCTIONS_KIND],
            authors: [owner],
            ids: batch,
            limit: batch.length,
            consistency: "strong",
          },
        ],
        this.ports.signal,
      );
      for (const event of found) {
        if (!batch.includes(event.id)) continue;
        await this.deleteVersion(event.id);
        store.dropCleanup(owner, community, event.id);
      }
    }
  }

  /** §3: publish staged local text, one agent at a time per community, then
   * confirm that exact event before the caller strips plugin config.
   * `configured` reads the plugin's value now: one edited since staging
   * becomes a draft and is never stripped (§3). */
  migrate(
    agent: string,
    strip: () => Promise<void>,
    configured?: () => string | undefined,
  ) {
    const run = this.migrating.then(() =>
      this.migrateOne(agent, strip, configured),
    );
    this.migrating = run.catch(() => {});
    return run;
  }
  private async migrateOne(
    agent: string,
    strip: () => Promise<void>,
    configured?: () => string | undefined,
  ) {
    const { store, outbox, owner, community } = this.ports;
    const key = this.key(agent);
    const entry = store.entry(key);
    if (entry?.migration.state !== "staged" || !this.eligible(agent)) return;
    const staged = entry.migration;
    const { sourceRevision } = staged;
    // The migration's own text never changes under it: a local edit made
    // meanwhile is kept as the draft, never overwritten by this snapshot.
    const settle = (migration: Migration) =>
      this.update(agent, (latest) => {
        const edited =
          latest.migration.state === "staged" &&
          latest.migration.text !== staged.text
            ? { draft: latest.migration.text }
            : {};
        return { ...latest, migration, ...edited };
      });
    const stripUnlessEdited = async () => {
      if (!this.alive || !this.eligible(agent) || !store.entry(key)) return;
      const now = configured?.();
      if (now === undefined || hash(now) === sourceRevision) return strip();
      this.update(agent, (latest) => ({ ...latest, draft: now }));
    };
    if (store.hadVersion(key)) {
      const head = entry.head;
      const current =
        head && "event" in head ? store.decodedText(head.event.id) : undefined;
      const same =
        current &&
        "text" in current &&
        current.text.trim() === staged.text.trim();
      store.write(key, {
        ...entry,
        migration: { state: "never" },
        ...(same ? {} : { draft: staged.text }),
      });
      if (same) await stripUnlessEdited();
      return;
    }
    let eventId = staged.eventId;
    if (!eventId) {
      const head = entry.head;
      eventId = await this.save(
        agent,
        staged.text,
        head && "event" in head ? head.event.id : undefined,
      );
      if (!settle({ ...staged, eventId })) return;
      if (outbox)
        try {
          await accepted(outbox, eventId, this.ports.signal);
        } catch (error) {
          const pending = this.pendingSave(agent);
          if (
            pending?.event.id === eventId &&
            refusesKind(saveState(pending, this.ports.now()))
          ) {
            // §3: history is unavailable here; the local editor stays, and a
            // later migration publishes again once the relay accepts it.
            store.markRefusesHistory(owner, community);
            await outbox.retire(eventId);
            this.update(agent, (latest) => {
              const { submitted: _, ...rest } = latest;
              const { eventId: _sent, ...unsent } = staged;
              return latest.migration.state === "staged"
                ? { ...rest, migration: unsent }
                : rest;
            });
          }
          throw error;
        }
    }
    const [confirmed] = await this.ports.read(
      [
        {
          kinds: [INSTRUCTIONS_KIND],
          authors: [owner],
          ids: [eventId],
          limit: 1,
          consistency: "strong",
        },
      ],
      this.ports.signal,
    );
    if (confirmed?.id !== eventId) throw new Error("Migration not confirmed");
    // A Delete Agent or a closed binding during the read wins over it.
    if (!settle({ state: "done", eventId })) return;
    // Installed like any received version, so a newer head or a deletion
    // that arrived meanwhile still wins.
    await this.receive([confirmed]);
    await stripUnlessEdited();
  }
}

/** Resolves when the outbox reports acceptance; rejects on any other end. */
function accepted(outbox: Outbox, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: unknown) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () => finish(signal.reason);
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(new Error(item.error ?? "Not confirmed"));
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

/** A short content-free fingerprint of a draft, for recovery bookkeeping. */
export function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
