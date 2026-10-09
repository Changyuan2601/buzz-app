import type { RelayEvent } from "./events.ts";
import type { ReadBlob } from "./read-state-model.ts";

export const READ_STATE_TIMESTAMP_REFUSAL =
  "invalid: event timestamp too far from server time";
/** Exact public relay reason only; never forward arbitrary rejection text. */
export function readStateRefusal(body: unknown): string | undefined {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error === READ_STATE_TIMESTAMP_REFUSAL
  )
    return READ_STATE_TIMESTAMP_REFUSAL;
}
export class ReadStateTimestampRejected extends Error {
  constructor() {
    super(READ_STATE_TIMESTAMP_REFUSAL);
  }
}

export type ReadStateSigning = Readonly<{
  slot: string;
  createdAt: number;
  blob: ReadBlob;
}>;
export type DecodedReadState = Readonly<{ eventId: string; blob: unknown }>;
/** Private host boundary: no generic NIP-44 or arbitrary-kind signing reaches plugins. */
export interface ReadStateHost {
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<readonly DecodedReadState[]>;
  sign?(intent: ReadStateSigning, signal: AbortSignal): Promise<RelayEvent>;
  publish?(event: RelayEvent, signal: AbortSignal): Promise<void>;
  /** Advertised independently through host-bound NIP-11, not echoed from the request. */
  readonly communityId?: string;
}
export const READ_SNAPSHOT_EVENTS = 4096;
export const READ_SNAPSHOT_BYTES = 8 * 1024 * 1024;
