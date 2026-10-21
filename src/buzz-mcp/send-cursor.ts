// Client-side admission for explicit conversation cursors. The relay does not
// compare-and-swap: independent hosts can still publish concurrently.
import { compareMessages, eventMs } from "../features/relay/message-order";
import { threadReference } from "../features/relay/thread-reference";
import type { BuzzClient, BuzzEvent } from "./client";

export const CONVERSATION_MESSAGES = [9, 40002, 40008, 45001, 45003];
const LIMIT = 1000;
type MessageHead = Pick<BuzzEvent, "id" | "created_at" | "tags">;
type Admission = { tail: Promise<void>; head?: MessageHead };
const communities = new Map<string, Map<string, Admission>>();
const standalone = new WeakMap<object, Map<string, Admission>>();

export function newestMessage<
  T extends Pick<BuzzEvent, "id" | "created_at" | "tags">,
>(events: readonly T[]) {
  return [...events].sort((a, b) =>
    compareMessages(
      { id: b.id, createdAt: b.created_at, createdAtMs: eventMs(b) },
      { id: a.id, createdAt: a.created_at, createdAtMs: eventMs(a) },
    ),
  )[0];
}

/** Serialize all local agents in a community, including the publish await.
 * Retain the last accepted event until relay reads include it, so delayed
 * read-after-write visibility cannot admit a second stale answer. */
export async function guardedSend(
  client: BuzzClient,
  channel: string,
  root: string | undefined,
  cursor: unknown,
  publish: () => Promise<BuzzEvent>,
  describe: (events: readonly BuzzEvent[]) => Promise<readonly string[]>,
) {
  const scope = client.sendScope ?? client.relayAuthor ?? client.query;
  // Every agent on the same local connection shares one admission queue.
  let conversations =
    typeof scope === "string" ? communities.get(scope) : standalone.get(scope);
  if (!conversations) {
    conversations = new Map();
    if (typeof scope === "string") communities.set(scope, conversations);
    else standalone.set(scope, conversations);
  }
  const key = JSON.stringify([channel, root]);
  let state = conversations.get(key);
  if (!state) {
    state = { tail: Promise.resolve() };
    conversations.set(key, state);
  }
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" || !/^(0|[a-f0-9]{64})$/.test(cursor))
    )
      throw new Error(
        "cursor must be a message ID, or 0 for an empty conversation.",
      );
    const found = await client.query([
      {
        kinds: CONVERSATION_MESSAGES,
        "#h": [channel],
        ...(root ? { "#e": [root] } : {}),
        limit: LIMIT,
      },
      ...(root
        ? [
            {
              ids: [root],
              kinds: CONVERSATION_MESSAGES,
              "#h": [channel],
              limit: 1,
            },
          ]
        : []),
    ]);
    // The relay orders by seconds, while Buzz also orders within a second.
    // Do not choose a head from a potentially truncated newest-second bucket.
    const latestSecond = Math.max(...found.map((event) => event.created_at));
    if (
      found.filter((event) => event.created_at === latestSecond).length >= LIMIT
    )
      throw new Error(
        "Conversation is too busy to establish its cursor. Nothing sent; read again.",
      );
    const messages = found.filter(
      (event) => !root || (threadReference(event)?.rootId ?? event.id) === root,
    );
    const head = newestMessage(
      state.head ? [...messages, state.head] : messages,
    );
    if (cursor !== (head?.id ?? "0")) {
      const latest = await describe(
        found
          .filter(
            (event) =>
              !root || (threadReference(event)?.rootId ?? event.id) === root,
          )
          .sort((a, b) => eventMs(a) - eventMs(b) || a.id.localeCompare(b.id))
          .slice(-50),
      );
      throw new Error(
        `${cursor === undefined ? "cursor is required" : "Stale cursor"}. Nothing sent. Reconsider your draft with this context before sending again.\ncursor ${head?.id ?? "0"}\n${latest.map((line) => line.slice(0, 4000)).join("\n")}`,
      );
    }
    const event = await publish();
    // Keep only admission evidence, never another agent's cached message body.
    state.head = {
      id: event.id,
      created_at: event.created_at,
      tags: event.tags,
    };
    return `sent ${event.id}\ncursor ${event.id}`;
  } finally {
    release();
  }
}
