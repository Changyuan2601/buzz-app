import type { EventData } from "./events";

/** The message's signed `audience` tag names agents: coordination between
 * agents, which people see quietly and are not notified of. Any other value,
 * or none, is for everyone. */
export const agentAudience = (event: EventData) =>
  event.tags.some(([name, value]) => name === "audience" && value === "agents");

/** The signed `audience` a message is shown with: `agents` is quiet
 * coordination between agents; `details` is fuller material for people, read
 * in its own viewer. Any other value, or none, is for everyone. */
export const messageAudience = (
  event: EventData,
): "agents" | "details" | undefined =>
  agentAudience(event)
    ? "agents"
    : event.tags.some(
          ([name, value]) => name === "audience" && value === "details",
        )
      ? "details"
      : undefined;

const HEADING =
  /^\s*#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*|$)/;

/** A `details` message opens with its title as a Markdown heading, so a client
 * without the details viewer still shows it as the heading. `start` is where
 * the rest begins in `content`; without a heading it is all body. */
export function detailsParts(content: string): {
  title: string | undefined;
  body: string;
  start: number;
} {
  const heading = HEADING.exec(content);
  const title = heading?.[1]?.trim();
  if (!heading || !title) return { title: undefined, body: content, start: 0 };
  const start = heading[0].length;
  return { title, body: content.slice(start), start };
}
