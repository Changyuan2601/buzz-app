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
/** Narrow enough that prose of any common font wraps at least this often. */
const MIN_CHARACTER_EM = 0.35;
/** Virtua's estimate for rows it has not measured. */
const VIRTUA_ITEM_SIZE = 40;
/**
 * Virtua estimates unmeasured rows at 40px, so a cold channel's bottom-anchored
 * first range mounts a viewport of them, then unmounts all but the few tall
 * rows that fill it. Each row's text gives a lower bound on its height: its
 * characters at a narrow average width wrap at the full list width, while
 * anything else it shows only adds height. A uniform estimate under which the
 * end holds as many rows as those bounds need to fill the viewport mounts no
 * row the viewport cannot show. Rows that are not prose bound nothing, and an
 * estimate below Virtua's own leaves its default.
 */
export function openingCache(
  rows: readonly ChannelMessage[],
  viewport: number,
  width: number,
  font: { size: number; line: number },
): VirtualizerHandle["cache"] | undefined {
  if (!viewport || !width) return undefined;
  let filled = 0;
  let count = 0;
  for (let index = rows.length - 1; index >= 0 && filled < viewport; index--) {
    const row = rows[index];
    count++;
    if (!row || row.membership || row.diff || row.huddle || row.audience)
      continue;
    // Fenced code does not wrap; link targets and mentions render shorter.
    const text = row.content
      .replace(/```[\s\S]*?(?:```|$)|\]\([^)]*\)|nostr:\w+/g, "")
      .trim();
    if (text)
      filled +=
        Math.max(
          1,
          Math.floor((text.length * MIN_CHARACTER_EM * font.size) / width),
        ) * font.line;
  }
  const size = viewport / count;
  // The snapshot only replaces the default size; every row stays unmeasured.
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
