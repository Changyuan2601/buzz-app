import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { assert, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import type { SharedAttentionIO } from "./shared-attention";

/** The relay's atomic create/prev contract. Each client gets a distinct signer. */
export function sharedRelay() {
  const heads = new Map<string, RelayEvent>();
  const history: RelayEvent[] = [];
  const tag = (event: RelayEvent, key: string) =>
    event.tags.find((t) => t[0] === key)?.[1];
  let uncertain = false;
  const client = (): SharedAttentionIO => {
    const key = generateSecretKey();
    return {
      read: vi.fn(async (filters) => {
        const filter = filters[0];
        assert.isDefined(filter);
        return [...heads.values()].filter(
          (e) =>
            (!filter["#d"] || filter["#d"].includes(tag(e, "d") ?? "")) &&
            (!filter["#h"] || filter["#h"].includes(tag(e, "h") ?? "")),
        );
      }),
      writer: {
        sign: async (event) => finalizeEvent(event, key),
        publish: vi.fn(async (event) => {
          const id = tag(event, "d");
          assert.isDefined(id);
          const prior = heads.get(id);
          if (
            tag(event, "op") === "create"
              ? !!prior
              : prior?.id !== tag(event, "prev")
          )
            throw new PublishRejected("conflict: artifact head changed");
          heads.set(id, event);
          history.push(event);
          if (uncertain) throw new Error("Receipt connection closes");
        }),
      },
    };
  };
  return {
    heads,
    history,
    client,
    setUncertain: (value: boolean) => {
      uncertain = value;
    },
  };
}
