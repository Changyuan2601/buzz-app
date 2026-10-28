import type { VirtualizerHandle } from "virtua";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ChannelQueries } from "../relay/contracts";

type Entry = {
  signature: string;
  width: number;
  cache: VirtualizerHandle["cache"];
};
/** Identity/session-scoped and bounded. Event content (not IDs alone) and exact layout width
 * invalidate measurements. Weak ownership releases geometry with the query session. */
const sessions = new WeakMap<ChannelQueries, Map<string, Entry>>();
export function geometryFor(queries: ChannelQueries) {
  const entries = sessions.get(queries) ?? new Map<string, Entry>();
  sessions.set(queries, entries);
  return {
    get(channelId: string, signature: string, width: number) {
      const entry = entries.get(channelId);
      return entry?.signature === signature && entry.width === width
        ? entry.cache
        : undefined;
    },
    set(
      channelId: string,
      signature: string,
      width: number,
      cache: VirtualizerHandle["cache"],
    ) {
      entries.delete(channelId);
      // Signatures include rendered text; bound that memory too, not only view count.
      if (signature.length > 256 * 1024) return;
      entries.set(channelId, { signature, width, cache });
      while (entries.size > 3) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
  };
}
/** Narrower than the average character of prose in any common font. */
const MIN_CHARACTER_EM = 0.35;
/** Virtua's estimate for rows it has not measured. */
const VIRTUA_ITEM_SIZE = 40;
/** Characters of a message that certainly render as wrapping text. Code
 * blocks and tables keep their lines, indented lines may be code, and
 * definitions, comments, markup, link targets, mentions and emoji render
 * shorter than their source, so none of them count. */
function proseLength(content: string) {
  let length = 0;
  let fenced = false;
  for (const line of content.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && !/^(\t| {4})|\||^ {0,3}\[[^\]]*\]:/.test(line))
      length += line
        .replace(
          /!?\[[^\]]*\]\([^)]*\)|<[^>]*>|nostr:\w+|:[\w+-]+:|[*_~`\\#>]/g,
          "",
        )
        .trim().length;
  }
  return length;
}
/**
 * Virtua estimates unmeasured rows at 40px, so a cold channel's end-aligned
 * first range mounts a viewport of rows, then unmounts all but the few tall
 * ones that fill it. A message's prose bounds its height from below: at a
 * narrow average width it wraps at least this often at the list's full width,
 * and everything else in the row only adds height. A uniform estimate that
 * gives the end as many rows as those bounds need to fill the viewport mounts
 * no row the viewport cannot show. Rows rendered without their text bound
 * nothing, and an estimate under Virtua's own keeps its default.
 */
export function openingCache(
  rows: readonly ChannelMessage[],
  viewport: number,
  width: number,
  font: { size: number; line: number },
): VirtualizerHandle["cache"] | undefined {
  let filled = 0;
  let count = 0;
  for (let index = rows.length - 1; index >= 0 && filled < viewport; index--) {
    const row = rows[index];
    count++;
    if (!row || row.membership || row.diff || row.huddle || row.audience)
      continue;
    const length = proseLength(row.content);
    if (length)
      filled +=
        Math.max(
          1,
          Math.floor((length * MIN_CHARACTER_EM * font.size) / width),
        ) * font.line;
  }
  const size = viewport / count;
  // Only the default size changes; every row stays unmeasured.
  return filled >= viewport && size > VIRTUA_ITEM_SIZE ? [[], size] : undefined;
}
const eventSignatures = new WeakMap<ChannelMessage, string>();
export const geometrySignature = (
  events: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) =>
  events
    .map((event) => {
      let signature = eventSignatures.get(event);
      if (!signature) {
        signature = JSON.stringify(event);
        eventSignatures.set(event, signature);
      }
      const ids = event.membership
        ? [event.membership.actor, event.membership.target]
        : [
            event.authorId,
            ...(event.workflowOwnerId ? [event.workflowOwnerId] : []),
            ...event.mentions,
            ...(event.mentionReferences ?? []),
          ];
      const names = resolveName
        ? ids.map((id) => resolveName(id, profiles.get(id)?.name ?? id))
        : event.workflowOwnerId
          ? [profiles.get(event.workflowOwnerId)?.name]
          : [];
      return `${JSON.stringify(names)}:${signature.length}:${signature}:${JSON.stringify(event.membership ? [profiles.get(event.membership.actor), profiles.get(event.membership.target)] : profiles.get(event.authorId))}`;
    })
    .join("");
