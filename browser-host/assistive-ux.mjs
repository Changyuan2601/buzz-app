import { createHmac } from "node:crypto";
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  ASSISTIVE_TAG,
  OUTCOMES,
  MAX_MARKERS,
  MAX_EVENT_BYTES,
  parseFact,
  parseRecord,
  assistiveCoordinate,
} from "../src/features/assistive-ux/protocol.ts";

const coordinate = (key, community, fact) =>
  `${ASSISTIVE_TAG}:${createHmac("sha256", key)
    .update(JSON.stringify([ASSISTIVE_TAG, community, fact.id, fact.outcome]))
    .digest("hex")}`;
export function assistiveAddresses(secret, community) {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return OUTCOMES.map((outcome) => {
      const fact = parseFact({ id: "threads.new-thread-placement", outcome });
      return { ...fact, coordinate: coordinate(key, community, fact) };
    });
  } finally {
    key.fill(0);
  }
}
export function decodeAssistive(events, secret, community) {
  if (
    !Array.isArray(events) ||
    events.length > MAX_MARKERS ||
    Buffer.byteLength(JSON.stringify(events)) > MAX_MARKERS * MAX_EVENT_BYTES
  )
    throw new Error("Assistive decode capacity exceeded");
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return events.map((raw) => {
      const event = eventDto(raw);
      if (
        event.pubkey !== getPublicKey(secret) ||
        !assistiveCoordinate(event) ||
        Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES
      )
        throw new Error("Invalid assistive event");
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 1024)
        throw new Error("Assistive plaintext capacity exceeded");
      const record = parseRecord(JSON.parse(plaintext), community);
      const fact = parseFact({ id: record.id, outcome: record.outcome });
      if (assistiveCoordinate(event) !== coordinate(key, community, fact))
        throw new Error("Assistive coordinate mismatch");
      return { eventId: event.id, fact };
    });
  } finally {
    key.fill(0);
  }
}
export function signAssistive(
  raw,
  secret,
  community,
  now = Math.floor(Date.now() / 1000),
) {
  const fact = parseFact(raw);
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    const event = finalizeEvent(
      {
        kind: 30078,
        created_at: now,
        tags: [
          ["d", coordinate(key, community, fact)],
          ["t", ASSISTIVE_TAG],
        ],
        content: nip44.v2.encrypt(
          JSON.stringify({ version: 1, community, ...fact }),
          key,
        ),
      },
      secret,
    );
    decodeAssistive([event], secret, community);
    return event;
  } finally {
    key.fill(0);
  }
}
