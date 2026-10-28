import {
  getEventHash,
  verifyEvent,
  verifiedSymbol,
  type Event,
  type VerifiedEvent,
} from "nostr-tools";
import { ByteLru, byteSize } from "./budget.ts";

// DOM-free admission checks shared by events.ts and the response intake worker.

export const invalidEvent = () =>
  new Error("Relay supplied a malformed or invalidly signed event");

/** The wire fields of a structurally valid event, copied before verification.
 * Anything malformed throws the same error as a bad signature. */
export function ownedEvent(value: unknown): Event {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidEvent();
  const raw = value as Record<string, unknown>;
  // nostr-tools validates only typeof number here. JSON overflow becomes Infinity
  // and hashes as null; fractions/unsafe integers cannot be protocol timestamps.
  if (
    typeof raw.created_at !== "number" ||
    !Number.isSafeInteger(raw.created_at) ||
    raw.created_at < 0 ||
    typeof raw.kind !== "number" ||
    !Number.isInteger(raw.kind) ||
    raw.kind < 0 ||
    raw.kind > 65535 ||
    typeof raw.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.id) ||
    typeof raw.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.pubkey) ||
    typeof raw.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(raw.sig) ||
    typeof raw.content !== "string" ||
    !Array.isArray(raw.tags) ||
    raw.tags.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((item) => typeof item !== "string"),
    )
  )
    throw invalidEvent();
  // Copy only wire fields before verification. Never trust a cached verification
  // symbol from a caller-owned object whose signed bytes may have changed.
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    sig: raw.sig,
    created_at: raw.created_at,
    kind: raw.kind,
    content: raw.content,
    tags: raw.tags.map((tag: string[]) => [...tag]),
  };
}

/** A bounded proof memo (one per HTTP connection here, one in the intake
 * worker), not an event/result cache. Only a matching content hash AND exact
 * signature can reuse a successful verification. Retains no payload,
 * authorization, freshness or caller-supplied proof symbols. */
export function createProofMemo() {
  const proofs = new ByteLru<string>(2048, 2048 * 192);
  return (event: Event): event is VerifiedEvent => {
    if (
      proofs.get(event.id) === event.sig &&
      getEventHash(event) === event.id
    ) {
      event[verifiedSymbol] = true;
      return true;
    }
    if (!verifyEvent(event)) return false;
    proofs.set(event.id, event.sig, 192); // fixed ASCII id (64) + signature (128)
    return true;
  };
}

export type CheckedResponse = { events: Event[]; sizes: number[] };

/** A whole relay read response with every event checked as `parseEvents` does,
 * plus each owned event's `byteSize`. Undefined for anything parseEvents would
 * reject, so the caller can reproduce its exact error on its own thread. */
export function checkResponse(
  text: string,
  proven: (event: Event) => event is VerifiedEvent,
): CheckedResponse | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return;
    const events: Event[] = [];
    const sizes: number[] = [];
    for (const value of raw) {
      const owned = ownedEvent(value);
      if (!proven(owned)) return;
      events.push(owned);
      sizes.push(byteSize(owned));
    }
    return { events, sizes };
  } catch {
    return;
  }
}
