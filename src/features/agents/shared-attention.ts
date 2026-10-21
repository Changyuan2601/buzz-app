import type { RelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import { PublishRejected } from "../relay/outbox";
import { uuidv5, type SnapshotRead } from "./agent-config-artifacts";
import type { SharedAttentionReference, TimerWatch } from "./attention";
import { utcCron } from "./cron";

export type SharedOccurrence = Readonly<{
  id: string;
  definition_revision: string;
  /** Unix seconds. */
  scheduled_at: number;
}>;
export type SharedAttentionProgress = Readonly<{
  version: 1;
  definition_id: string;
  definition_revision: string;
  used: number;
  next_due: number;
  occurrence: SharedOccurrence;
  /** Consumption is durable before dispatch. Recovery never repeats it. */
  result: "uncertain" | "completed" | "cancelled" | "failed";
  admission_id: string;
  armed_at?: number;
}>;
export type SharedAttentionCapability = Readonly<{
  supported: boolean;
  reason?: string;
}>;
export type SharedAttentionRunResult = Readonly<{
  status: "queued";
  requestId: string;
}>;
export type SharedAttention = Readonly<{
  capability(pubkey: string): SharedAttentionCapability;
  progress(
    pubkey: string,
    slug: string,
    occurrenceId?: string,
  ): Promise<SharedAttentionProgress | undefined>;
  runNow(
    pubkey: string,
    slug: string,
    requestId: string,
  ): Promise<SharedAttentionRunResult>;
}>;
export type SharedAttentionIO = Readonly<{
  read: SnapshotRead;
  writer: RelayWriter;
}>;
export type SharedCandidate = Readonly<{
  reference: SharedAttentionReference;
  id: string;
  head?: RelayEvent | undefined;
  progress: SharedAttentionProgress;
  interval_secs?: number;
}>;
const TYPE = "buzz.agent.attention-progress";
const tag = (event: RelayEvent, key: string) =>
  event.tags.find((t) => t[0] === key)?.[1];
const integer = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;
export const isRequestId = (id: string) =>
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id);

async function head(
  io: SharedAttentionIO,
  channel: string,
  id: string,
  signal: AbortSignal,
) {
  const events = await io.read(
    [
      {
        kinds: [45010],
        "#h": [channel],
        "#d": [id],
        artifact: "current",
        limit: 2,
      },
    ],
    { signal },
  );
  if (events.length > 1) throw new Error("Shared attention head is ambiguous");
  const event = events[0];
  if (event && (tag(event, "d") !== id || tag(event, "h") !== channel))
    throw new Error("Shared attention head does not match");
  return event;
}
export async function sharedDefinitionCurrent(
  io: SharedAttentionIO,
  ref: SharedAttentionReference,
  signal: AbortSignal,
) {
  const event = await head(io, ref.channel_id, ref.definition_id, signal);
  if (
    !event ||
    event.id !== ref.definition_revision ||
    tag(event, "op") === "delete"
  )
    return false;
  const value = JSON.parse(event.content);
  return value?.id === ref.definition_id && value?.enabled === true;
}
const progressId = (ref: SharedAttentionReference) =>
  uuidv5(ref.definition_id, `attention:${ref.definition_revision}`);
function decode(
  event: RelayEvent,
  ref: SharedAttentionReference,
): SharedAttentionProgress {
  const value = JSON.parse(event.content) as SharedAttentionProgress;
  if (
    tag(event, "type") !== TYPE ||
    tag(event, "op") === "delete" ||
    value.version !== 1 ||
    value.definition_id !== ref.definition_id ||
    value.definition_revision !== ref.definition_revision ||
    !integer(value.used) ||
    !integer(value.next_due) ||
    (value.armed_at !== undefined && !integer(value.armed_at)) ||
    !value.occurrence ||
    typeof value.occurrence.id !== "string" ||
    value.occurrence.definition_revision !== ref.definition_revision ||
    !integer(value.occurrence.scheduled_at) ||
    typeof value.admission_id !== "string" ||
    !["uncertain", "completed", "cancelled", "failed"].includes(value.result)
  )
    throw new Error("Invalid shared attention progress");
  return value;
}
export async function readSharedProgress(
  io: SharedAttentionIO,
  ref: SharedAttentionReference,
  signal: AbortSignal,
  occurrenceId?: string,
) {
  if (
    occurrenceId !== undefined &&
    !(occurrenceId.startsWith("manual:")
      ? isRequestId(occurrenceId.slice(7))
      : /^[0-9a-f]{64}$/.test(occurrenceId))
  )
    throw new Error("Invalid occurrence ID");
  const id =
    occurrenceId === undefined
      ? await progressId(ref)
      : await uuidv5(
          ref.definition_id,
          occurrenceId.startsWith("manual:")
            ? `attention:${occurrenceId}`
            : `attention:${ref.definition_revision}:event:${occurrenceId}`,
        );
  const event = await head(io, ref.channel_id, id, signal);
  return event ? decode(event, ref) : undefined;
}

/** A fresh relay read decides interval progress. Cron considers only this minute. */
export async function sharedTimerCandidate(
  io: SharedAttentionIO,
  timer: TimerWatch,
  now: number,
  signal: AbortSignal,
  requestId?: string,
): Promise<SharedCandidate | undefined> {
  const ref = timer.shared;
  if (
    !ref ||
    !timer.enabled ||
    now < timer.armed_at ||
    (timer.expires_at !== null && now >= timer.expires_at)
  )
    return;
  if (!requestId && timer.cron_utc && !utcCron(timer.cron_utc)(now)) return;
  if (!(await sharedDefinitionCurrent(io, ref, signal))) return;
  const id = await progressId(ref);
  const saved = await head(io, ref.channel_id, id, signal);
  const prior = saved ? decode(saved, ref) : undefined;
  if (
    timer.max_occurrences !== null &&
    (prior?.used ?? 0) >= timer.max_occurrences
  )
    return;
  const minute = Math.floor(now / 60) * 60;
  const scheduled = requestId
    ? now
    : timer.cron_utc
      ? minute
      : prior?.armed_at === timer.armed_at
        ? prior.next_due
        : timer.armed_at + timer.interval_secs;
  if (
    !requestId &&
    (now < scheduled ||
      (timer.cron_utc &&
        (!utcCron(timer.cron_utc)(minute) || (prior?.next_due ?? 0) > minute)))
  )
    return;
  const occurrence: SharedOccurrence = {
    id: requestId ? `manual:${requestId}` : `timer:${scheduled}`,
    definition_revision: ref.definition_revision,
    scheduled_at: scheduled,
  };
  return {
    reference: ref,
    id,
    ...(saved ? { head: saved } : {}),
    ...(!timer.cron_utc ? { interval_secs: timer.interval_secs } : {}),
    progress: {
      armed_at: timer.armed_at,
      version: 1,
      definition_id: ref.definition_id,
      definition_revision: ref.definition_revision,
      used: (prior?.used ?? 0) + 1,
      next_due: timer.cron_utc ? minute + 60 : now + timer.interval_secs,
      occurrence,
      result: "uncertain",
      admission_id: crypto.randomUUID(),
    },
  };
}
export async function sharedEventCandidate(
  ref: SharedAttentionReference,
  event: RelayEvent,
): Promise<SharedCandidate> {
  return {
    reference: ref,
    id: await uuidv5(
      ref.definition_id,
      `attention:${ref.definition_revision}:event:${event.id}`,
    ),
    progress: {
      version: 1,
      definition_id: ref.definition_id,
      definition_revision: ref.definition_revision,
      used: 1,
      next_due: 0,
      occurrence: {
        id: event.id,
        definition_revision: ref.definition_revision,
        scheduled_at: event.created_at,
      },
      result: "uncertain",
      admission_id: crypto.randomUUID(),
    },
  };
}
async function write(
  io: SharedAttentionIO,
  candidate: SharedCandidate,
  signal: AbortSignal,
  admission = false,
) {
  const { reference: ref, id, head: prior } = candidate;
  const progress =
    admission && candidate.interval_secs !== undefined
      ? {
          ...candidate.progress,
          next_due: Math.floor(Date.now() / 1000) + candidate.interval_secs,
        }
      : candidate.progress;
  const signed = await io.writer.sign(
    {
      kind: 45010,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify(progress),
      tags: [
        ["ar", "1"],
        ["d", id],
        ["h", ref.channel_id],
        ["type", TYPE],
        ["title", "Agent attention progress"],
        ["op", prior ? "update" : "create"],
        ...(prior ? [["prev", prior.id]] : []),
      ],
    },
    signal,
  );
  // A unique admission_id prevents equal signed events from granting two callers admission.
  try {
    const receipt = await io.writer.publish(signed, signal);
    if (typeof receipt === "string" && /^duplicate:/i.test(receipt)) return;
    return signed;
  } catch (error) {
    if (
      error instanceof PublishRejected &&
      /^(conflict|duplicate):/.test(error.reason ?? error.message)
    )
      return;
    throw error;
  }
}
/** Only a confirmed new CAS winner can dispatch. Uncertain writes grant nothing. */
export async function admitShared(
  io: SharedAttentionIO,
  candidate: SharedCandidate,
  signal: AbortSignal,
  requestId?: string,
) {
  if (!(await sharedDefinitionCurrent(io, candidate.reference, signal))) return;
  if (requestId) {
    const marker: SharedCandidate = {
      ...candidate,
      id: await uuidv5(
        candidate.reference.definition_id,
        `attention:manual:${requestId}`,
      ),
      head: undefined,
    };
    const consumed = await write(io, marker, signal, true);
    if (!consumed) return;
    const accepted = await write(io, candidate, signal, true);
    if (!accepted)
      await write(
        io,
        {
          ...marker,
          head: consumed,
          progress: { ...marker.progress, result: "cancelled" },
        },
        signal,
      );
    return accepted;
  }
  return write(io, candidate, signal, true);
}
export async function finishShared(
  io: SharedAttentionIO,
  candidate: SharedCandidate,
  accepted: RelayEvent,
  result: "completed" | "cancelled" | "failed",
  signal: AbortSignal,
) {
  const progress = decode(accepted, candidate.reference);
  const writes: (() => Promise<unknown>)[] = [
    () =>
      write(
        io,
        { ...candidate, head: accepted, progress: { ...progress, result } },
        signal,
      ),
  ];
  if (candidate.progress.occurrence.id.startsWith("manual:"))
    writes.push(async () => {
      const id = await uuidv5(
        candidate.reference.definition_id,
        `attention:${candidate.progress.occurrence.id}`,
      );
      const marker = await head(io, candidate.reference.channel_id, id, signal);
      if (
        marker &&
        decode(marker, candidate.reference).admission_id ===
          candidate.progress.admission_id
      )
        await write(
          io,
          { ...candidate, id, head: marker, progress: { ...progress, result } },
          signal,
        );
    });
  const results = await Promise.allSettled(writes.map((write) => write()));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Shared result is uncertain",
    );
}

export function sharedAttentionIO(
  session:
    | Partial<
        Pick<
          RelaySession,
          "artifactAdmission" | "snapshotRead" | "configArtifactWriter"
        >
      >
    | undefined,
): SharedAttentionIO | undefined {
  return session?.artifactAdmission &&
    session.snapshotRead &&
    session.configArtifactWriter
    ? { read: session.snapshotRead, writer: session.configArtifactWriter }
    : undefined;
}
