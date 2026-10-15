import type { RelayEvent } from "../relay/events";
import type { AssistiveExperienceId } from "./catalog";

export const ASSISTIVE_TAG = "buzz-assistive-v1";
export const OUTCOMES = ["seen", "dismissed", "completed"] as const;
export type AssistiveOutcome = (typeof OUTCOMES)[number];
export type ProgressFact = Readonly<{
  id: AssistiveExperienceId;
  outcome: AssistiveOutcome;
}>;
export type ProgressRecord = ProgressFact &
  Readonly<{ version: 1; community: string }>;
export type ProgressAddress = ProgressFact & Readonly<{ coordinate: string }>;
export const MAX_MARKERS = 96;
export const MAX_EVENT_BYTES = 4096;

export function parseFact(raw: unknown): ProgressFact {
  const value = raw as Partial<ProgressFact> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["id", "outcome"].includes(key)) ||
    value.id !== "threads.new-thread-placement" ||
    !OUTCOMES.includes(value.outcome as AssistiveOutcome)
  )
    throw new Error("Invalid assistive fact");
  return { id: value.id, outcome: value.outcome as AssistiveOutcome };
}
export function parseRecord(raw: unknown, community: string): ProgressRecord {
  const value = raw as Partial<ProgressRecord> | null;
  if (
    value?.version !== 1 ||
    value.community !== community ||
    Object.keys(value).some(
      (key) => !["version", "community", "id", "outcome"].includes(key),
    )
  )
    throw new Error("Invalid assistive record");
  return {
    version: 1,
    community,
    ...parseFact({ id: value.id, outcome: value.outcome }),
  };
}
export function factKey(fact: ProgressFact) {
  return `${fact.id}:${fact.outcome}`;
}
export function assistiveCoordinate(event: Pick<RelayEvent, "kind" | "tags">) {
  const [d, t] = event.tags;
  return event.kind === 30078 &&
    event.tags.length === 2 &&
    d?.length === 2 &&
    d[0] === "d" &&
    /^buzz-assistive-v1:[a-f0-9]{64}$/.test(d[1] ?? "") &&
    t?.length === 2 &&
    t[0] === "t" &&
    t[1] === ASSISTIVE_TAG
    ? d[1]
    : undefined;
}
/** Purpose-bound host codec; no secret or general encryption/signing API. */
export interface AssistiveHost {
  addresses(signal: AbortSignal): Promise<readonly ProgressAddress[]>;
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<readonly { eventId: string; fact: ProgressFact }[]>;
  sign(fact: ProgressFact, signal: AbortSignal): Promise<RelayEvent>;
  publish(event: RelayEvent, signal: AbortSignal): Promise<void>;
}
