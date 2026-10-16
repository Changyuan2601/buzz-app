import { getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  OBSERVER_KIND,
  observerFrame,
} from "../src/features/agents/observer.ts";

/** Purpose-bound, synchronous decode in the existing key-owning host only.
 * Relay admission establishes the agent/owner relationship; tags alone do not. */
export function decodeAgentObserver(input, secret, viewer) {
  if (input.kind !== OBSERVER_KIND)
    throw new Error("Invalid observer envelope");
  return decodeAgentArchive(input, secret, viewer);
}
export function decodeAgentArchive(input, secret, viewer, history = false) {
  if (getPublicKey(secret) !== viewer)
    throw new Error("Observer viewer changed");
  const event = eventDto(input);
  const exact = (name, value) => {
    const tags = event.tags.filter((tag) => tag[0] === name);
    return tags.length === 1 && tags[0].length === 2 && tags[0][1] === value;
  };
  if (
    ![OBSERVER_KIND, 44200].includes(event.kind) ||
    !exact("p", viewer) ||
    !exact("agent", event.pubkey) ||
    (event.kind === OBSERVER_KIND && !exact("frame", "telemetry")) ||
    event.content.length < 132 ||
    event.content.length > 87472 ||
    event.created_at > Math.floor(Date.now() / 1000) + 300 ||
    // Saved metrics may outlive 90 days; their store retention bounds them.
    ((!history || event.kind === OBSERVER_KIND) &&
      Date.now() - event.created_at * 1000 >
        (history ? 90 * 24 * 60 * 60 * 1000 : 300_000))
  )
    throw new Error("Invalid observer envelope");
  const key = nip44.v2.utils.getConversationKey(secret, event.pubkey);
  try {
    return observerFrame({
      id: event.id,
      agent: event.pubkey,
      createdAt: event.created_at,
      plaintext: nip44.v2.decrypt(event.content, key),
    });
  } finally {
    key.fill(0);
  }
}
