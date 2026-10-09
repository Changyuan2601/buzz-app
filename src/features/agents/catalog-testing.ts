import { finalizeEvent, type EventTemplate } from "nostr-tools";
import type { ReadFilter, RelayEvent } from "../relay/events.ts";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox.ts";
import type { Key } from "../relay/testing.ts";
import { catalogD, isShared } from "./catalog-protocol.ts";

/** A NIP-33 relay with the NIP-AP author-only-unless-shared read gate. */
export function catalogRelay() {
  const stored = new Map<string, RelayEvent>();
  let refuse = false;
  let held: Promise<void> | undefined;
  const put = (event: RelayEvent) => {
    const key = `${event.kind}:${event.pubkey}:${catalogD(event)}`;
    const head = stored.get(key);
    if (
      !head ||
      event.created_at > head.created_at ||
      (event.created_at === head.created_at && event.id < head.id)
    )
      stored.set(key, event);
  };
  return {
    put,
    refuse(value: boolean) {
      refuse = value;
    },
    /** Holds publishes unanswered until the returned release is called. */
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
    reader(as: Key) {
      return {
        async read(filters: readonly ReadFilter[]) {
          const [filter] = filters;
          return [...stored.values()]
            .filter(
              (event) =>
                filter?.kinds?.includes(event.kind) &&
                (event.pubkey === as.pubkey || isShared(event)),
            )
            .sort((a, b) => b.created_at - a.created_at);
        },
      };
    },
    writer(as: Key) {
      return {
        sign: async (template: EventTemplate) =>
          finalizeEvent(structuredClone(template), as.secret) as RelayEvent,
        publish: async (event: RelayEvent) => {
          await held;
          if (refuse) throw new PublishRejected("blocked: not today");
          put(event);
        },
      };
    },
  };
}
export function memoryStorage(): OutboxStorage {
  let records: readonly OutgoingEvent[] = [];
  return {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
}
