// The agents' saved settings: one record for each membership, and the one
// queue each record's changes take. The Runner, which runs agents, owns them
// and is their only writer. The Manager, which the screens use, asks for its
// changes as `RecordEdit` data, so they can later cross to the Runner's page.
import { parseSlug, type AttentionObject } from "./attention";
import { pubkeyOf, type AgentKey } from "./membership";
import type { AgentIdentity } from "./native";
import type { AgentChange } from "./service";
import type { AgentStore } from "./state";
import {
  readRecords,
  recordKey,
  removeRecord,
  setAttention,
  splitLegacyRecords,
  withProgress,
  writeRecord,
  type AgentRecord,
  type TimerProgress,
} from "./store";

export type Member = AgentIdentity & Readonly<{ key: AgentKey }>;

/** A change the Manager asks of a membership's record. */
export type RecordEdit =
  /** A new agent's first settings. */
  | Readonly<{ kind: "create"; record: AgentRecord }>
  /** The owner's change to its config or attention. Its config is its home
   * record's, in every community; the rest is this membership's own. */
  | Readonly<{
      kind: "settings";
      member: Member;
      change: Pick<
        AgentChange,
        "config" | "attentionEnabled" | "attention" | "restart"
      >;
    }>
  /** It left this community: its home record keeps the agent's settings,
   * but not what it paid attention to there. */
  | Readonly<{ kind: "leave" }>
  /** Its agent is gone, or it left this community. */
  | Readonly<{ kind: "remove" }>;

export const EMPTY = Object.freeze({});
export const blank = (key: AgentKey): AgentRecord => ({
  pubkey: key,
  attention: EMPTY,
  config: undefined,
});
/** What a membership other than the agent's home keeps of `record`: its
 * attention and timers. */
const ownRecord = (
  key: AgentKey,
  { config: _, ...record }: AgentRecord,
): AgentRecord => ({ ...record, pubkey: key, config: undefined });
/** `record` with the owner's `change` to its settings; throws when the
 * change is not valid for it. */
function changed(record: AgentRecord, change: AgentChange): AgentRecord {
  let next = record;
  if (change.config !== undefined) next = { ...next, config: change.config };
  if (change.attentionEnabled !== undefined) {
    const { attentionEnabled: _, ...rest } = next;
    next = change.attentionEnabled ? { ...rest, attentionEnabled: true } : rest;
  }
  for (const [slug, value] of Object.entries(change.attention ?? {}))
    next = setAttention(
      next,
      slug,
      value,
      undefined,
      change.restart?.includes(slug) ? "restart" : undefined,
    );
  // As the spec's writer: an Interest stays while anything still uses it.
  for (const [slug, value] of Object.entries(change.attention ?? {})) {
    const id = parseSlug(slug)?.id;
    if (value !== null || !slug.startsWith("interest/") || !id) continue;
    if (
      Object.values(next.attention).some(
        (object) =>
          object.value.type !== "interest" && object.value.interest_id === id,
      )
    )
      throw new Error(
        "Remove or move the watches and timers that use this Interest first",
      );
  }
  return next;
}

export type RecordsHost = Readonly<{
  /** The settings a new agent of this type starts with, if its type is here. */
  defaults(
    identity: Pick<AgentIdentity, "pubkey" | "type">,
  ): AgentRecord | undefined;
  /** A record changed and is shown. */
  changed(): void;
  /** The record's changes all settled, saved or failed. */
  settled(key: AgentKey): void;
}>;

export class AgentRecords {
  private records: Readonly<Record<AgentKey, AgentRecord>>;
  private readonly changes = new Map<AgentKey, Promise<void>>();
  private readonly changing = new Map<AgentKey, number>();
  private readonly progressing = new Map<AgentKey, readonly TimerProgress[]>();

  constructor(
    private readonly storage: AgentStore,
    private readonly host: RecordsHost,
  ) {
    this.records = readRecords(storage);
    void splitLegacyRecords(storage, this.records);
  }

  all() {
    return Object.values(this.records);
  }
  keys() {
    return Object.keys(this.records);
  }
  saved(key: AgentKey): AgentRecord | undefined {
    return this.records[key];
  }
  /** A change to it is waiting or being saved. */
  isChanging(key: AgentKey) {
    return this.changing.has(key);
  }

  /** Applies the Manager's `edit` to the membership's record. */
  async edit(key: AgentKey, edit: RecordEdit) {
    switch (edit.kind) {
      case "create":
        await this.change(key, () => edit.record);
        return;
      case "remove":
        await this.change(key, () => null);
        return;
      case "leave":
        await this.change(key, (saved) => {
          if (!saved) return null;
          const {
            skipped: _,
            timers: __,
            attentionEnabled: ___,
            ...rest
          } = saved;
          return { ...rest, attention: {} };
        });
        return;
      case "settings": {
        const { member, change } = edit;
        const home = key === member.pubkey;
        if (!home && change.config !== undefined)
          await this.change(member.pubkey, (saved) =>
            changed(saved ?? this.settingsOf(member), {
              config: change.config,
            }),
          );
        const own = home ? change : { ...change, config: undefined };
        if (
          own.config !== undefined ||
          own.attention ||
          own.attentionEnabled !== undefined
        )
          await this.change(key, (saved) =>
            changed(saved ?? this.recordOf(member), own),
          );
        return;
      }
    }
  }

  /** Changes one agent's record. This is the only way a record changes:
   * owner settings, the agent's attention tools, timer progress, a provider
   * change and removal all send a change here. One agent's changes run in
   * the order they are sent, each after the one before it is saved or has
   * failed, so each one applies to the newest saved record, never to a copy
   * another change replaces. `apply` gets that record (or undefined) and
   * returns the next one, or null to remove it; it may throw to change
   * nothing. The owner and the agent see a change once it is saved, and the
   * promise settles then. When the save fails, the promise rejects and they
   * keep the saved record, so a form keeps its unsaved changes. `saved`
   * runs as the change is shown, before anyone is told. Only the Runner
   * passes a function; the Manager sends an `edit`. */
  change(
    key: AgentKey,
    apply: (
      record: AgentRecord | undefined,
    ) => AgentRecord | null | Promise<AgentRecord | null>,
    saved?: (record: AgentRecord | null) => void,
  ): Promise<AgentRecord | null> {
    this.changing.set(key, (this.changing.get(key) ?? 0) + 1);
    return this.queued(key, async () => {
      try {
        const base = this.records[key];
        const next = await apply(base);
        await this.commit(key, base, next);
        saved?.(next);
        this.host.changed();
        return next;
      } finally {
        const left = (this.changing.get(key) ?? 1) - 1;
        if (left) this.changing.set(key, left);
        else {
          this.changing.delete(key);
          // Its timers waited for this change, saved or failed.
          this.host.settled(key);
        }
      }
    });
  }
  /** Records that timers ran or started counting, as a change to their run
   * state only. It applies to whatever the record is when its turn comes, so
   * it never undoes a change sent before it: when a timer was rearmed or
   * restarted meanwhile, its new deadline stays and only the occurrences it
   * used are added. Timers see it at once (`timersOf`), and memory keeps it
   * even when its save fails, so a timer does not run again at once. */
  progress(key: AgentKey, ran: TimerProgress) {
    const pending = this.progressing.get(key) ?? [];
    this.progressing.set(key, [...pending, ran]);
    void this.queued(key, async () => {
      try {
        const base = this.records[key];
        const next = base && withProgress(base, ran);
        if (!base || !next) return;
        await this.commit(key, base, next).catch((error) => {
          console.warn(`Agent ${key} timer state was not saved`, error);
          this.records = { ...this.records, [key]: next };
        });
        this.host.changed();
      } finally {
        const left = (this.progressing.get(key) ?? []).filter(
          (entry) => entry !== ran,
        );
        if (left.length) this.progressing.set(key, left);
        else this.progressing.delete(key);
      }
    });
  }
  /** Keeps what an attention object's last wake and its source printed, while
   * the object is the same. */
  history(
    key: AgentKey,
    object: AttentionObject,
    output?: string,
    lastWokeAt?: number,
  ) {
    void this.queued(key, async () => {
      const record = this.records[key];
      if (!record || record.attention[object.slug] !== object) return;
      const prior = record.attentionHistory?.[object.slug];
      const entry = {
        ...prior,
        ...(lastWokeAt !== undefined ? { lastWokeAt } : {}),
        ...(output !== undefined
          ? {
              output: [prior?.output, output]
                .filter((part) => part !== undefined && part !== "")
                .join(prior?.output?.endsWith("\n") ? "" : "\n")
                .slice(-16384)
                .split("\n")
                .slice(-40)
                .join("\n"),
            }
          : {}),
      };
      await this.commit(key, record, {
        ...record,
        attentionHistory: { ...record.attentionHistory, [object.slug]: entry },
      });
      this.host.changed();
    }).catch((error) => console.warn("Attention history was not saved", error));
  }
  /** The agent's timers' run state as its timers go by: saved, with the
   * progress still being saved. */
  timersOf(key: AgentKey) {
    const record = this.records[key];
    const pending = this.progressing.get(key);
    if (!record || !pending) return record?.timers ?? EMPTY;
    return (
      pending.reduce((next, ran) => withProgress(next, ran) ?? next, record)
        .timers ?? EMPTY
    );
  }
  /** The agent's home record, which keeps its config: as saved or, without
   * one, its type's defaults, kept in memory until a save stores them.
   * Without its type there are no defaults yet. */
  settingsOf(identity: Pick<AgentIdentity, "pubkey" | "type">) {
    const { pubkey } = identity;
    if (!this.records[pubkey]) {
      const record = this.host.defaults(identity);
      if (record) this.records = { ...this.records, [pubkey]: record };
    }
    return this.records[pubkey] ?? blank(pubkey);
  }
  /** The membership's settings as its owner and agent see them: its own
   * attention, starting with none, and the agent's config. */
  recordOf(member: Member): AgentRecord {
    const settings = this.settingsOf(member);
    if (member.key === member.pubkey) return settings;
    const own = this.records[member.key] ?? blank(member.key);
    return { ...own, config: settings.config };
  }

  /** Runs `step` after the agent's earlier changes have settled. */
  private queued<T>(key: AgentKey, step: () => Promise<T>) {
    const run = (this.changes.get(key) ?? Promise.resolve()).then(step);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.changes.set(key, tail);
    void tail.then(() => {
      if (this.changes.get(key) === tail) this.changes.delete(key);
    });
    return run;
  }
  /** Saves `next` over `base` in the membership's own key, then keeps it.
   * Only this key: others may be another program's to change. A record
   * other than the agent's home record keeps no config, which is the
   * agent's, never one community's. */
  private async commit(
    key: AgentKey,
    base: AgentRecord | undefined,
    given: AgentRecord | null,
  ) {
    if (given === base) return;
    const next = given && key !== pubkeyOf(key) ? ownRecord(key, given) : given;
    if (next) await writeRecord(this.storage, next);
    else if (this.storage.get(recordKey(key)) !== null)
      await removeRecord(this.storage, key);
    const { [key]: _, ...others } = this.records;
    this.records = next ? { ...others, [key]: next } : others;
  }
}
