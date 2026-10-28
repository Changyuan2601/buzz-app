import {
  verifyEvent,
  verifiedSymbol,
  type Event,
  type VerifiedEvent,
} from "nostr-tools";
import { rememberByteSize } from "./budget.ts";
import {
  createProofMemo,
  invalidEvent,
  ownedEvent,
  type CheckedResponse,
} from "./event-checks.ts";
import { createResponseIntake } from "./event-intake.ts";
/** A relay event whose signature has been verified at the transport boundary. */
export type RelayEvent = VerifiedEvent;
/** Event payload shared by locally authored intent and verified relay records.
 * Only RelayEvent carries signature verification; local intent never establishes relay authority. */
export type EventData = Readonly<
  Pick<RelayEvent, "id" | "pubkey" | "created_at" | "kind" | "content" | "tags">
>;
export type ReadFilter = Readonly<{
  kinds?: readonly number[];
  ids?: readonly string[];
  /** NIP-01 single-letter tag filters, including references (#e/#a) and topics (#t). */
  [tag: `#${string}`]: readonly string[] | undefined;
  limit: number;
  authors?: readonly string[];
  /** Read from the writer when resolving uncertain publication or admission. */
  consistency?: "strong";
  /** NIP-AR artifact reads: current heads only, or a `d`'s revision history. */
  artifact?: "current" | "history";
  /** NIP-AR artifact page offset (≤ 10,000). */
  offset?: number;
  until?: number;
  since?: number;
  "#h"?: readonly string[];
  "#d"?: readonly string[];
  "#p"?: readonly string[];
  /** Buzz relay extensions for channel history windows. */
  top_level?: boolean;
  include_aux?: boolean;
  include_summaries?: boolean;
  before_id?: string;
  /** HTTP bridge finite search, home-feed, and thread traversal extensions. */
  search?: string;
  search_mode?: "prefix" | "fulltext";
  /** Only for relays advertising `buzz-search-sort`. */
  search_sort?: "newest";
  page?: number;
  feed_types?: readonly string[];
  thread_window?: boolean;
  depth_limit?: number;
  thread_cursor?: number;
  thread_cursor_id?: string;
}>;
// Identity-only evidence for immutable records owned by this admission boundary.
// Neither a caller-provided nostr-tools symbol nor a copied record is proof.
const admitted = new WeakSet<object>();
export function hasEventProof(event: EventData): boolean {
  return admitted.has(event);
}

export function eventDto(value: unknown): RelayEvent {
  return checkedEvent(value, verifyEvent);
}

/** A whole query response; one bad event rejects it, as relay reads do. */
export function eventsDto(value: unknown): RelayEvent[] {
  if (!Array.isArray(value))
    throw new Error("Relay response is not an event array");
  return value.map(eventDto);
}

export function createEventVerifier(): EventVerifier {
  const proven = createProofMemo();
  const verify = (value: unknown): RelayEvent => checkedEvent(value, proven);
  const intake = createResponseIntake();
  if (!intake) return verify;
  return Object.assign(verify, {
    response: async (text: string) => admitChecked(await intake({ text })),
  });
}

/** Restored cache records as one all-or-nothing batch, each checked exactly
 * as `eventDto(JSON.parse(JSON.stringify(value)))` would, off the main thread.
 * Undefined when this thread must check them: no worker, or any rejection. */
export async function checkSavedEvents(
  saved: readonly unknown[],
): Promise<RelayEvent[] | undefined> {
  const intake = createResponseIntake();
  return intake ? admitChecked(await intake({ saved })) : undefined;
}

function admitChecked(checked: CheckedResponse | undefined) {
  if (!checked) return;
  const { events, sizes } = checked;
  return events.map((owned, index) => {
    owned[verifiedSymbol] = true;
    rememberByteSize(owned, sizes[index] as number);
    return admit(owned);
  });
}

export type EventVerifier = ((value: unknown) => RelayEvent) & {
  /** A whole JSON read response, checked off the main thread. Undefined when
   * this thread must parse and check it instead: no worker, or anything
   * `parseEvents` would reject. */
  response?: (text: string) => Promise<RelayEvent[] | undefined>;
};

function checkedEvent(
  value: unknown,
  verify: (event: Event) => event is VerifiedEvent,
): RelayEvent {
  const owned = ownedEvent(value);
  if (!verify(owned)) throw invalidEvent();
  return admit(owned);
}

function admit(owned: Event): RelayEvent {
  for (const tag of owned.tags) Object.freeze(tag);
  Object.freeze(owned.tags);
  Object.freeze(owned);
  admitted.add(owned);
  return owned as RelayEvent;
}

export const tag = (event: RelayEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
export const hasTag = (event: RelayEvent, name: string, value: string) =>
  event.tags.some((entry) => entry[0] === name && entry[1] === value);

/** Later created_at wins; ties break on lower id so replay order cannot flip the result. */
export function newer<T extends EventData>(
  current: T | undefined,
  candidate: T,
): T {
  return !current ||
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
    ? candidate
    : current;
}
