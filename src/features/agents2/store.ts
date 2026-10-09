// Device-local settings for Agents2 agents: each agent's attention objects in the
// `agent-attention/v1` shape, one JSON blob its plugin type owns, and its timers'
// run state. Which agents exist, their type and name, and their keys live in
// native custody, never here; a record without an identity does nothing. A
// relay-backed store can replace this later without changing the record shape.
import {
  OBJECT_LIMIT,
  sameSchedule,
  timerState,
  validateObject,
  type AttentionObject,
  type AttentionValue,
  type TimerState,
} from "./attention";

/** An object a reader cannot apply, kept as it was stored so it can be fixed. */
export type SkippedObject = Readonly<{
  slug: string;
  value: unknown;
  modifiedAt: number;
  problem: string;
}>;
export type AgentRecord = Readonly<{
  pubkey: string;
  /** Keyed by slug (`interest/<id>` or `watch/<id>`). */
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored objects that are invalid or over a limit. They do nothing, and stay
   * stored until they are fixed or removed. */
  skipped?: Readonly<Record<string, SkippedObject>>;
  /** Plugin-owned config. The host never reads it. */
  config: unknown;
  /** Run state of its timers, by slug. Not config, so it never leaves the device;
   * kept here so removing a timer or the agent removes its state with it. */
  timers?: Readonly<Record<string, TimerState>>;
}>;
type Stored = { version: 1; agents: Record<string, AgentRecord> };

export const STORAGE_KEY = "buzz.agents2.v1";
const PUBKEY = /^[0-9a-f]{64}$/;
const group = (value: AttentionValue) =>
  value.type === "interest" ? "Interests" : "watches and timers";

/** Reads every record. An attention object a reader would not apply is skipped
 * and reported, never dropped. */
export function readRecords(storage: Storage): Record<string, AgentRecord> {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return {};
  }
  if (
    !stored ||
    typeof stored !== "object" ||
    (stored as Stored).version !== 1 ||
    typeof (stored as Stored).agents !== "object"
  )
    return {};
  const records: Record<string, AgentRecord> = {};
  for (const [pubkey, record] of Object.entries((stored as Stored).agents)) {
    if (!PUBKEY.test(pubkey) || record?.pubkey !== pubkey) continue;
    const attention: Record<string, AttentionObject> = {};
    const skipped: Record<string, SkippedObject> = {};
    const counts = { Interests: 0, "watches and timers": 0 };
    const entries = Object.entries(record.attention ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [slug, object] of entries) {
      const modifiedAt = Number.isSafeInteger(object?.modifiedAt)
        ? object.modifiedAt
        : 0;
      let problem =
        object?.slug === slug
          ? validateObject(slug, object.value)
          : "Stored under another slug";
      if (!problem) {
        const kind = group(object.value);
        if (++counts[kind] > OBJECT_LIMIT)
          problem = `Over the limit of ${OBJECT_LIMIT} ${kind}`;
      }
      if (problem)
        skipped[slug] = { slug, value: object?.value, modifiedAt, problem };
      else attention[slug] = { slug, value: object.value, modifiedAt };
    }
    const timers: Record<string, TimerState> = {};
    for (const [slug, state] of Object.entries(record.timers ?? {}))
      if (
        attention[slug]?.value.type === "timer" &&
        [state?.armedAt, state?.nextDue, state?.used].every(
          Number.isSafeInteger,
        )
      )
        timers[slug] = state;
    records[pubkey] = {
      pubkey,
      attention,
      skipped,
      config: record.config,
      timers,
    };
  }
  return records;
}

export function writeRecords(
  storage: Storage,
  records: Readonly<Record<string, AgentRecord>>,
) {
  // Skipped objects go back where they were read from, so a later reader that
  // can apply them still finds them.
  const agents = Object.fromEntries(
    Object.entries(records).map(([pubkey, { skipped, ...record }]) => [
      pubkey,
      {
        ...record,
        attention: {
          ...Object.fromEntries(
            Object.values(skipped ?? {}).map(({ problem: _, ...object }) => [
              object.slug,
              object,
            ]),
          ),
          ...record.attention,
        },
      },
    ]),
  );
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, agents } as Stored),
  );
}

/** Replaces or deletes (`value: null`) one attention object, after validating it
 * and the count limits. A timer keeps its run state only while its schedule
 * (`armed_at`, `interval_secs`, `enabled`) is unchanged; otherwise it recounts. */
export function setAttention(
  record: AgentRecord,
  slug: string,
  value: AttentionValue | null,
  now = Math.floor(Date.now() / 1000),
): AgentRecord {
  const prior = record.attention[slug]?.value;
  const { [slug]: _, ...rest } = record.attention;
  const { [slug]: __, ...skipped } = record.skipped ?? {};
  const { [slug]: state, ...timers } = record.timers ?? {};
  if (value === null) return { ...record, attention: rest, skipped, timers };
  const problem = validateObject(slug, value);
  if (problem) throw new Error(problem);
  const kind = group(value);
  if (
    !prior &&
    Object.values(rest).filter((object) => group(object.value) === kind)
      .length >= OBJECT_LIMIT
  )
    throw new Error(`An agent can have at most ${OBJECT_LIMIT} ${kind}`);
  const kept =
    value.type === "timer"
      ? {
          ...timers,
          [slug]:
            state && prior?.type === "timer" && sameSchedule(prior, value)
              ? state
              : timerState(value, undefined, now),
        }
      : timers;
  return {
    ...record,
    attention: { ...rest, [slug]: { slug, value, modifiedAt: now } },
    skipped,
    timers: kept,
  };
}
