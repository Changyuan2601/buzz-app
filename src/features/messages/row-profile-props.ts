import { rowProfileIds } from "../relay/membership";
import type { MessageRowProps } from "./MessageRow";

/**
 * Memo equality for a message row. Its list shares one profile map and agent
 * set across every row, so a new author or mention anywhere in the list
 * replaces both. A row reads them only for its own identities (and for any
 * profile its text links, `nostr:npub1…`), so other entries never re-render it.
 */
export function sameRowProps(
  previous: MessageRowProps,
  next: MessageRowProps,
): boolean {
  const keys = Object.keys(next) as (keyof MessageRowProps)[];
  if (keys.length !== Object.keys(previous).length) return false;
  for (const key of keys) {
    if (key === "participantProfiles" || key === "agentPubkeys") continue;
    if (!Object.hasOwn(previous, key) || !Object.is(previous[key], next[key]))
      return false;
  }
  const profiles = [previous.participantProfiles, next.participantProfiles];
  const agents = [previous.agentPubkeys, next.agentPubkeys];
  if (profiles[0] === profiles[1] && agents[0] === agents[1]) return true;
  // Without a map the row reads the whole session directory; a text link can
  // name any profile.
  if (!profiles[0] !== !profiles[1] || !agents[0] !== !agents[1]) return false;
  if (next.row.content.includes("npub1")) return false;
  return rowProfileIds(next.row).every(
    (id) =>
      profiles[0]?.get(id) === profiles[1]?.get(id) &&
      !!agents[0]?.has(id) === !!agents[1]?.has(id),
  );
}
