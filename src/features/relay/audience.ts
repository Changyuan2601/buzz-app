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

/** What the chat shows of a details message before it opens: its first
 * paragraph, after a leading heading when an older message has one. */
export function detailsBrief(content: string) {
  const blocks = content.trim().split(/\n\s*\n/);
  const shown = /^#{1,6}\s/.test(blocks[0] ?? "") ? 2 : 1;
  return blocks.slice(0, shown).join("\n\n");
}
