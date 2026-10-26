import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
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
 * block, after a leading heading when an older message has one. Blocks are
 * Markdown's, as the chat renders them, so a heading, list or fence that
 * starts without a blank line still ends the brief. */
export function detailsBrief(content: string) {
  const blocks = fromMarkdown(content, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }).children;
  const first = blocks[0];
  const last = first?.type === "heading" ? (blocks[1] ?? first) : first;
  const start = first?.position?.start.offset;
  const end = last?.position?.end.offset;
  return start === undefined || end === undefined
    ? content.trim()
    : content.slice(start, end);
}
