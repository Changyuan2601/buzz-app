import { type AgentRecord, type TimerProgress, withProgress } from "./store";

const EMPTY = Object.freeze({});

/** Where the records are kept, for `RecordChanges`. */
export type RecordStore = Readonly<{
  /** The agent's record as kept now. */
  saved: (pubkey: string) => AgentRecord | undefined;
  /** Saves `next` over `base` (null removes it), then keeps it. */
  commit: (
    pubkey: string,
    base: AgentRecord | undefined,
    next: AgentRecord | null,
  ) => Promise<void>;
  /** Keeps `next` without saving it. */
  keep: (pubkey: string, next: AgentRecord) => void;
  /** A change was kept: tell the owner and the agent. */
  changed: () => void;
  /** The agent has no changes left: its timers can run. */
  settled: (pubkey: string) => void;
}>;

/** The changes to each agent's record. This is the only way a record
 * changes: owner settings, the agent's attention tools, timer progress, a
 * provider change and removal all send a change here. */
export class RecordChanges {
  /** Each agent's last change in its queue, until it settles. */
  private readonly changes = new Map<string, Promise<void>>();
  /** How many changes other than timer progress each agent has queued. */
  private readonly counts = new Map<string, number>();
  /** Each agent's timer progress that is not saved yet. */
  private readonly progressing = new Map<string, readonly TimerProgress[]>();

  constructor(private readonly store: RecordStore) {}

  /** Whether the agent has changes other than timer progress queued. */
  changing(pubkey: string) {
    return this.counts.has(pubkey);
  }

  /** Changes one agent's record. One agent's changes run in the order they
   * are sent, each after the one before it is saved or has failed, so each
   * one applies to the newest saved record, never to a copy another change
   * replaces. `apply` gets that record (or undefined) and returns the next
   * one, or null to remove it; it may throw to change nothing. The owner and
   * the agent see a change once it is saved, and the promise settles then.
   * When the save fails, the promise rejects and they keep the saved record,
   * so a form keeps its unsaved changes. `saved` runs as the change is
   * shown, before anyone is told. */
  change(
    pubkey: string,
    apply: (
      record: AgentRecord | undefined,
    ) => AgentRecord | null | Promise<AgentRecord | null>,
    saved?: (record: AgentRecord | null) => void,
  ): Promise<AgentRecord | null> {
    this.counts.set(pubkey, (this.counts.get(pubkey) ?? 0) + 1);
    return this.queued(pubkey, async () => {
      try {
        const base = this.store.saved(pubkey);
        const next = await apply(base);
        await this.store.commit(pubkey, base, next);
        saved?.(next);
        this.store.changed();
        return next;
      } finally {
        const left = (this.counts.get(pubkey) ?? 1) - 1;
        if (left) this.counts.set(pubkey, left);
        else {
          this.counts.delete(pubkey);
          // Its timers waited for this change, saved or failed.
          this.store.settled(pubkey);
        }
      }
    });
  }

  /** Records that timers ran or started counting, as a change to their run
   * state only. It applies to whatever the record is when its turn comes, so
   * it never undoes a change sent before it: when a timer was rearmed or
   * restarted meanwhile, its new deadline stays and only the occurrences it
   * used are added. Timers see it at once (`timers`), and memory keeps it
   * even when its save fails, so a timer does not run again at once. */
  progress(pubkey: string, ran: TimerProgress) {
    const pending = this.progressing.get(pubkey) ?? [];
    this.progressing.set(pubkey, [...pending, ran]);
    void this.queued(pubkey, async () => {
      try {
        const base = this.store.saved(pubkey);
        const next = base && withProgress(base, ran);
        if (!base || !next) return;
        await this.store.commit(pubkey, base, next).catch((error) => {
          console.warn(`Agent ${pubkey} timer state was not saved`, error);
          this.store.keep(pubkey, next);
        });
        this.store.changed();
      } finally {
        const left = (this.progressing.get(pubkey) ?? []).filter(
          (entry) => entry !== ran,
        );
        if (left.length) this.progressing.set(pubkey, left);
        else this.progressing.delete(pubkey);
      }
    });
  }

  /** The agent's timers' run state as its timers go by: saved, with the
   * progress still being saved. */
  timers(pubkey: string) {
    const record = this.store.saved(pubkey);
    const pending = this.progressing.get(pubkey);
    if (!record || !pending) return record?.timers ?? EMPTY;
    return (
      pending.reduce((next, ran) => withProgress(next, ran) ?? next, record)
        .timers ?? EMPTY
    );
  }

  /** Runs `step` after the agent's earlier changes have settled. */
  private queued<T>(pubkey: string, step: () => Promise<T>) {
    const run = (this.changes.get(pubkey) ?? Promise.resolve()).then(step);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.changes.set(pubkey, tail);
    void tail.then(() => {
      if (this.changes.get(pubkey) === tail) this.changes.delete(pubkey);
    });
    return run;
  }
}
