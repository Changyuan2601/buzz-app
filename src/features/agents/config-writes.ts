// Every artifact write this app makes (plan §5): the migration journal
// `buzz.agents.config.migration.v1` for an agent's existing local config, and
// saves as revisions. A write is persisted before it is sent and resent as the
// identical signed bytes until it resolves, and every head it installs passes
// `checkedHead` against the selected channel. Dormant until config ships.
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import {
  artifactOp,
  artifactTemplate,
  checkedHead,
  deliver,
  type Expected,
  readHead,
  type Refusal,
  settle,
  type SnapshotRead,
} from "./agent-config-artifacts";
import type { AgentConfigStore, Subject } from "./agent-config";
import type { Mode } from "./agent-start";

export const MIGRATION_STORAGE_KEY = "buzz.agents.config.migration.v1";

export type MigrationStatus =
  | "pending"
  | "staged"
  | "dispatched"
  | "uncertain"
  | "confirmed"
  | "superseded"
  | "adopted"
  | "blocked"
  | "accepted-unavailable"
  | "failed";

/** The launch mode of a type in each journal status (§4.1). */
export const MODE: Readonly<Record<MigrationStatus, Mode>> = {
  pending: "migrating",
  staged: "migrating",
  dispatched: "migrating",
  uncertain: "migrating",
  failed: "migrating",
  confirmed: "synced",
  superseded: "synced",
  adopted: "synced",
  blocked: "synced",
  "accepted-unavailable": "synced",
};

export type Migration = Readonly<{
  status: MigrationStatus;
  channelId: string;
  d: string;
  /** The exact content staged for publishing, and its SHA-256. */
  stagedValue?: string;
  stagedHash?: string;
  eventId?: string;
  signedEvent?: RelayEvent;
  competingHeadId?: string;
  /** This device's value, kept for review when it isn't the head. */
  draft?: string;
  error?: string;
  attempts: number;
}>;

/** One journal entry per `owner:community:agent:type`. */
export const migrationKey = (subject: Subject) =>
  `${subject.owner}:${subject.community}:${subject.subject}:${subject.type}`;

/** A signed save not yet resolved. `unsent`: its last send was definitely
 * not accepted (rate-limited), so a replay's refusal is definitive too. */
type Held = Readonly<{ event: RelayEvent; unsent?: true }>;

export class MigrationJournal {
  private entries: Record<string, Migration> = {};
  private saves: Record<string, Held> = {};
  /** Saves retired from replay that may still have been accepted (§3.5). */
  private maybe: Record<string, string> = {};
  /** Each subject's latest save or resend, which the next waits for. */
  private writing = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: Storage = localStorage) {
    try {
      const value = JSON.parse(
        storage.getItem(MIGRATION_STORAGE_KEY) ?? "null",
      ) as {
        version?: unknown;
        entries?: unknown;
        saves?: unknown;
        maybe?: unknown;
      } | null;
      if (value?.version !== 1) return;
      if (value.entries && typeof value.entries === "object")
        this.entries = value.entries as Record<string, Migration>;
      if (value.saves && typeof value.saves === "object")
        this.saves = value.saves as Record<string, Held>;
      if (value.maybe && typeof value.maybe === "object")
        this.maybe = value.maybe as Record<string, string>;
    } catch {
      /* Start fresh after malformed local data. */
    }
  }
  get = (subject: Subject): Migration | undefined =>
    this.entries[migrationKey(subject)];
  /** Persisted before the caller's next relay write. */
  put(subject: Subject, entry: Migration) {
    this.entries[migrationKey(subject)] = entry;
    this.save();
  }
  /** A signed save not yet resolved, by subject, so a restart resends it. */
  unsaved = (subject: Subject): Held | undefined =>
    this.saves[migrationKey(subject)];
  holdSave(subject: Subject, held: Held | undefined) {
    if (held) this.saves[migrationKey(subject)] = held;
    else delete this.saves[migrationKey(subject)];
    this.save();
  }
  /** Runs `run` once the subject's earlier save or resend has finished, so
   * one held save is signed, sent and resolved at a time. */
  serially<T>(subject: Subject, run: () => Promise<T>): Promise<T> {
    const key = migrationKey(subject);
    const next = (this.writing.get(key) ?? Promise.resolve()).then(run, run);
    const done = next.then(
      () => undefined,
      () => undefined,
    );
    this.writing.set(key, done);
    void done.then(() => {
      if (this.writing.get(key) === done) this.writing.delete(key);
    });
    return next;
  }
  /** The id of a save that may have been saved: never declared unaccepted,
   * only resolved by a later accepted save of the subject. */
  maybeSaved = (subject: Subject): string | undefined =>
    this.maybe[migrationKey(subject)];
  /** Retires a held save, recording in the same write whether it may have
   * been accepted, so no crash can lose that evidence. */
  retireSave(subject: Subject, maybe: string | undefined) {
    const key = migrationKey(subject);
    delete this.saves[key];
    if (maybe) this.maybe[key] = maybe;
    else delete this.maybe[key];
    this.save();
  }
  private save() {
    this.storage.setItem(
      MIGRATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: this.entries,
        saves: this.saves,
        maybe: this.maybe,
      }),
    );
  }
}

export async function sha256(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type WriteDeps = Readonly<{
  read: SnapshotRead;
  writer: RelayWriter;
  store: AgentConfigStore;
  journal: MigrationJournal;
  maxEventBytes: number;
  signal: AbortSignal;
}>;

/** One type of one agent's local config, and how to retire it. */
export type LocalSide = Readonly<{
  subject: Subject;
  expected: Expected;
  title: string;
  /** Client tags the revision carries, e.g. `team` and `imported-from`. */
  extra?: readonly (readonly string[])[];
  /** The local value as artifact content, read fresh each time. */
  content(): string;
  /** Removes this type's local field once its exact value is the head;
   * given `accepted`, only if the local value is exactly that head. */
  strip(accepted?: RelayEvent): void;
}>;

/** A side a save is sent for; with `strip`, this device's own accepted save
 * retires the local field it came from. */
type Sending = Pick<LocalSide, "subject" | "expected"> &
  Partial<Pick<LocalSide, "strip">>;

/** Definitive refusals are retried this many times before `failed`. */
const ATTEMPTS = 3;
const SETTLED = new Set<MigrationStatus>([
  "confirmed",
  "superseded",
  "adopted",
  "blocked",
]);

/** Installs a read head through `checkedHead`, fenced by `capture`. */
function install(
  deps: WriteDeps,
  side: LocalSide,
  capture: ReturnType<AgentConfigStore["capture"]>,
  head: RelayEvent,
) {
  const result = checkedHead(head, side.expected);
  deps.store.applyRead(side.subject, capture, result);
  return result;
}

/** Reads the current head and installs it through `checkedHead`: the head
 * barrier a recovered channel passes before starts use it (§8.1). */
export async function refresh(deps: WriteDeps, side: LocalSide) {
  const capture = deps.store.capture(side.subject);
  const head = await readHead(
    deps.read,
    side.expected.channel,
    side.expected.d,
    deps.signal,
  );
  if (head) install(deps, side, capture, head);
}

/** Runs one type's migration (§5.2) from wherever its journal left it, and
 * returns the entry it persisted last. Safe to call again at any time: on
 * reconnect, on restart, or after `failed` for Retry. */
export async function migrate(
  deps: WriteDeps,
  side: LocalSide,
): Promise<Migration> {
  const { journal, store } = deps;
  let entry: Migration = journal.get(side.subject) ?? {
    status: "pending",
    channelId: side.expected.channel,
    d: side.expected.d,
    attempts: 0,
  };
  const put = (next: Migration) => {
    journal.put(side.subject, next);
    entry = next;
    return next;
  };
  if (!journal.get(side.subject)) put(entry);
  if (SETTLED.has(entry.status)) return entry;

  // Sent before: resolve those exact bytes, never a fresh signature.
  if (entry.signedEvent && entry.status !== "failed")
    return resolve(deps, side, entry, put);

  let lost = 0;
  for (;;) {
    const capture = store.capture(side.subject);
    const head = await readHead(
      deps.read,
      side.expected.channel,
      side.expected.d,
      deps.signal,
    );
    if (head) {
      const result = install(deps, side, capture, head);
      store.markHadVersion(side.subject);
      const local = side.content();
      if (result.problem || artifactOp(head) === "delete")
        return put({ ...entry, status: "blocked", draft: local });
      if (head.content === local) side.strip();
      const { draft: _, ...rest } = entry;
      return put({
        ...rest,
        status: "adopted",
        ...(head.content === local ? {} : { draft: local }),
      });
    }
    const stagedValue = side.content();
    put({
      ...entry,
      status: "staged",
      stagedValue,
      stagedHash: await sha256(stagedValue),
    });
    const signedEvent = await deps.writer.sign(
      artifactTemplate({
        ...side.expected,
        op: "create",
        title: side.title,
        content: stagedValue,
        ...(side.extra ? { extra: side.extra } : {}),
      }),
      deps.signal,
    );
    put({
      ...entry,
      status: "dispatched",
      eventId: signedEvent.id,
      signedEvent,
    });
    const settled = await resolve(deps, side, entry, put);
    // Another device took the identity first: look again, never update it.
    if (settled.status !== "pending") return settled;
    if (++lost >= ATTEMPTS)
      return put({
        ...settled,
        status: "failed",
        error: "Another device holds this config, but it can't be read yet",
      });
    put(settled);
  }
}

/** Sends the journaled bytes and records the outcome (§3.5, §5.2 step 4).
 * Returns `pending` only when a create lost the identity race. */
async function resolve(
  deps: WriteDeps,
  side: LocalSide,
  entry: Migration,
  put: (next: Migration) => Migration,
): Promise<Migration> {
  const event = entry.signedEvent;
  if (!event) throw new Error("Nothing was signed for this migration");
  const capture = deps.store.capture(side.subject);
  if (entry.status !== "accepted-unavailable") {
    const sent = await deliver(
      deps.writer,
      event,
      deps.signal,
      deps.maxEventBytes,
    );
    if (sent.status === "uncertain")
      return put({ ...entry, status: "uncertain", error: sent.message });
    if (sent.status === "refused")
      return refused(deps, side, entry, put, sent.refusal, sent.message);
  }
  // Positive proof of acceptance: local launch authority ends here.
  deps.store.markHadVersion(side.subject);
  const after = await settle(deps.read, event, deps.signal);
  if (after.status === "accepted-unavailable")
    return put({
      ...entry,
      status: "accepted-unavailable",
      draft: entry.stagedValue ?? "",
    });
  const result = install(deps, side, capture, after.head);
  const local = side.content();
  const unchanged = (await sha256(local)) === entry.stagedHash;
  const { draft: _, error: __, ...rest } = entry;
  if (after.status === "current" && !result.problem) {
    if (unchanged) side.strip();
    return put({
      ...rest,
      status: "confirmed",
      ...(unchanged ? {} : { draft: local }),
    });
  }
  return put({
    ...rest,
    status: "superseded",
    competingHeadId: after.head.id,
    ...(after.head.content === local ? {} : { draft: local }),
  });
}

/** A typed refusal of the journaled event. Only a first send can be
 * definitively unaccepted: a resend of an uncertain event stays uncertain
 * whatever the relay says now, since the original may have been accepted. */
async function refused(
  deps: WriteDeps,
  side: LocalSide,
  entry: Migration,
  put: (next: Migration) => Migration,
  refusal: Refusal,
  message: string,
): Promise<Migration> {
  if (entry.status === "uncertain") {
    const head =
      refusal === "conflict"
        ? await readHead(
            deps.read,
            side.expected.channel,
            side.expected.d,
            deps.signal,
          )
        : undefined;
    return put({
      ...entry,
      error: message,
      draft: entry.stagedValue ?? "",
      ...(head ? { competingHeadId: head.id } : {}),
    });
  }
  const { signedEvent: _, eventId: __, ...unsent } = entry;
  // A create refused as identity-taken: the head lookup decides again.
  if (refusal === "conflict") return { ...unsent, status: "pending" };
  const attempts = entry.attempts + 1;
  if (refusal === "rate-limited" && attempts < ATTEMPTS)
    return put({ ...entry, status: "uncertain", error: message, attempts });
  return put({ ...unsent, status: "failed", error: message, attempts });
}

export type Saved =
  | Readonly<{ status: "saved"; head: RelayEvent }>
  /** Changed elsewhere first: `head` is installed, the edit stays a draft. */
  | Readonly<{ status: "conflict" | "superseded"; head?: RelayEvent }>
  /** "May have been saved". `retired: false`: held and resent as the same
   * bytes by `resume`. `retired: true`: the relay refused a replay, which
   * proves nothing (§3.5); `head`, if any, is the competing head. */
  | Readonly<{
      status: "uncertain";
      message: string;
      retired: boolean;
      head?: RelayEvent;
    }>
  | Readonly<{ status: "accepted-unavailable" }>
  | Readonly<{ status: "refused"; refusal: Refusal; message: string }>;

/** The head's JSON object, or none when it has no readable one. */
export function headFields(head: RelayEvent | undefined) {
  try {
    const value: unknown = head && JSON.parse(head.content);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Readonly<Record<string, unknown>>;
  } catch {
    /* An unreadable head has no fields to keep. */
  }
  return {};
}

/** `fields` over the head's JSON object, so an edit keeps the fields this
 * client doesn't know (NIP-AP "Editing"). */
export const edited = (
  head: RelayEvent | undefined,
  fields: Readonly<Record<string, unknown>>,
) => JSON.stringify({ ...headFields(head), ...fields });

/** The tags a revision carries forward from the head it edits: everything
 * but the ones `artifactTemplate` writes itself (NIP-AP "Editing"). */
const OWN_TAGS = new Set(["ar", "d", "h", "type", "title", "op", "prev"]);
function carried(
  head: RelayEvent | undefined,
  extra: readonly (readonly string[])[] = [],
) {
  const replaced = new Set(extra.map(([name]) => name));
  return [
    ...(head?.tags ?? []).filter(
      ([name = ""]) => !OWN_TAGS.has(name) && !replaced.has(name),
    ),
    ...extra,
  ];
}

/** Saves an edit as the next revision of a synced artifact (§5.3, §7):
 * `op=update` on `base`, the head the editor opened (`null`: it opened none),
 * or on the stored head when no editor base is known. An editor that opened an
 * older head than the stored one conflicts without sending. The revision keeps
 * the base head's client tags. The signed event is held until it resolves. */
export function save(
  deps: WriteDeps,
  side: Sending & Pick<LocalSide, "title">,
  content: string,
  extra?: readonly (readonly string[])[],
  base?: string | null,
): Promise<Saved> {
  return write(deps, side, base, (head, prev) =>
    artifactTemplate({
      ...side.expected,
      title: side.title,
      content,
      ...(prev ? { op: "update", prev } : { op: "create" }),
      extra: carried(head, extra),
    }),
  );
}

/** Saves `template`, a revision built on head `base` (a History revert or
 * restore), with the same conflict check, hold and send as an edit. */
export const revise = (
  deps: WriteDeps,
  side: Sending,
  template: ReturnType<typeof artifactTemplate>,
  base: string,
) => write(deps, side, base, () => template);

async function write(
  deps: WriteDeps,
  side: Sending,
  base: string | null | undefined,
  template: (
    head: RelayEvent | undefined,
    prev: string | undefined,
  ) => ReturnType<typeof artifactTemplate>,
): Promise<Saved> {
  return deps.journal.serially(side.subject, async () => {
    if (deps.journal.unsaved(side.subject)) {
      const earlier = await resend(deps, side);
      if (earlier?.status === "uncertain" && !earlier.retired) return earlier;
    }
    const capture = deps.store.capture(side.subject);
    const head = deps.store.state(side.subject).head;
    const prev = base === undefined ? head?.id : (base ?? undefined);
    if (head && head.id !== prev) return { status: "conflict", head };
    const event = await deps.writer.sign(template(head, prev), deps.signal);
    deps.journal.holdSave(side.subject, { event });
    return send(deps, side, { event }, capture, false);
  });
}

/** Resends a held save's identical bytes; undefined when none is held. */
export const resume = (deps: WriteDeps, side: Sending) =>
  deps.journal.serially(side.subject, () => resend(deps, side));

async function resend(deps: WriteDeps, side: Sending) {
  const held = deps.journal.unsaved(side.subject);
  return (
    held &&
    send(deps, side, held, deps.store.capture(side.subject), !held.unsent)
  );
}

/** `replay`: an earlier send of these bytes may have been accepted, so no
 * refusal now proves it wasn't (§3.5). */
async function send(
  deps: WriteDeps,
  side: Sending,
  held: Held,
  capture: ReturnType<AgentConfigStore["capture"]>,
  replay: boolean,
): Promise<Saved> {
  const { event } = held;
  /** Only an accepted save resolves an earlier one that may have been. */
  const done = (result: Saved, accepted = false) => {
    deps.journal.retireSave(
      side.subject,
      accepted ? undefined : deps.journal.maybeSaved(side.subject),
    );
    return result;
  };
  const installHead = async () => {
    const head = await readHead(
      deps.read,
      side.expected.channel,
      side.expected.d,
      deps.signal,
    );
    if (head)
      deps.store.applyRead(
        side.subject,
        capture,
        checkedHead(head, side.expected),
      );
    return head;
  };
  const sent = await deliver(
    deps.writer,
    event,
    deps.signal,
    deps.maxEventBytes,
  );
  if (sent.status === "uncertain") {
    if (held.unsent) deps.journal.holdSave(side.subject, { event });
    return { status: "uncertain", message: sent.message, retired: false };
  }
  if (sent.status === "refused") {
    if (sent.refusal === "rate-limited") {
      if (!replay) deps.journal.holdSave(side.subject, { event, unsent: true });
      return { status: "uncertain", message: sent.message, retired: false };
    }
    const head = sent.refusal === "conflict" ? await installHead() : undefined;
    if (replay) {
      deps.journal.retireSave(side.subject, event.id);
      return {
        status: "uncertain",
        message: `It may have been saved, but the relay now says: ${sent.message}`,
        retired: true,
        ...(head ? { head } : {}),
      };
    }
    if (sent.refusal === "conflict")
      return done({ status: "conflict", ...(head ? { head } : {}) });
    return done({
      status: "refused",
      refusal: sent.refusal,
      message: sent.message,
    });
  }
  deps.store.markHadVersion(side.subject);
  const after = await settle(deps.read, event, deps.signal);
  if (after.status === "accepted-unavailable")
    return done({ status: "accepted-unavailable" }, true);
  deps.store.applyRead(
    side.subject,
    capture,
    checkedHead(after.head, side.expected),
  );
  // Fresh and replayed sends alike: once installed, a local value that is
  // exactly the accepted head retires; a newer draft stays.
  if (after.status === "current") side.strip?.(after.head);
  return done(
    after.status === "current"
      ? { status: "saved", head: after.head }
      : { status: "superseded", head: after.head },
    true,
  );
}
