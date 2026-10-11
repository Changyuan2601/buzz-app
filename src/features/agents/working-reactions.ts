// STOPGAP(agent-working-reactions): DELETE once agents show as typing
// through the relay. Every piece is tagged STOPGAP(agent-working-reactions):
// grep for it and delete this file, its import and use in service.ts, and its
// test. Keep `Delivery.workingUntil`, which typing indicators need too.
//
// While an agent works on a mention it reacts to it with 👀 and 💬, then takes
// both back.
import type { RelayEvent } from "../relay/events";
import type { AgentEventTemplate } from "./native";

const EMOJI = ["👀", "💬"] as const;

/** Reacts to `event` as the agent now; the returned function takes the
 * reactions back once they have been published. */
export function reactWhileWorking(
  publish: (event: AgentEventTemplate) => Promise<RelayEvent>,
  event: RelayEvent,
  channelId: string,
): () => void {
  const reactions = Promise.allSettled(
    EMOJI.map(async (emoji) =>
      publish({
        kind: 7,
        content: emoji,
        tags: [
          ["h", channelId],
          ["e", event.id],
        ],
      }),
    ),
  );
  return () =>
    void reactions
      .then((results) => {
        const ids = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.id] : [],
        );
        if (ids.length < results.length)
          console.warn("Agent working reactions were not all published");
        // The relay takes one target per deletion.
        return Promise.all(
          ids.map((id) =>
            publish({
              kind: 5,
              content: "",
              tags: [
                ["h", channelId],
                ["e", id],
                ["k", "7"],
              ],
            }),
          ),
        );
      })
      .catch((error) =>
        console.warn("Agent working reactions were not removed", error),
      );
}
