// Whether an agent is in an event's channel, and whether that channel is its
// DM, by the relay-signed roster of a session that hears the channel: the
// owner's in the app, the agent's own on a standalone host.
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";

/** The event's channel as the session lists it, if at all. */
function channelOf(session: RelaySession | undefined, event: RelayEvent) {
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
  const channels = session?.channels;
  if (!channel || !channels) return undefined;
  return (
    channels.list().channels.find((item) => item.id === channel) ??
    channels.get?.(channel)
  );
}

/** Whether the agent is in the event's channel, by its relay-signed roster.
 * The stream may be another's, so a watch, even of "all", sees only what the
 * agent itself could read; an event with no channel, or whose roster is
 * unknown, wakes no watch. A roster only loaded from disk decides nothing
 * (undefined): the agent may have been removed or added since it was saved,
 * so the event waits until the relay confirms it. */
export function rosterMember(
  session: RelaySession | undefined,
  agent: string,
  event: RelayEvent,
): boolean | undefined {
  const summary = channelOf(session, event);
  if (summary?.cached) return undefined;
  return !!summary?.members?.includes(agent);
}

/** Whether the event's channel is a DM of exactly the agent and one other,
 * by the same roster. A group DM, or one whose roster is unknown, is not. */
export function rosterDm(
  session: RelaySession | undefined,
  agent: string,
  event: RelayEvent,
) {
  const summary = channelOf(session, event);
  return (
    summary?.channelType === "dm" &&
    summary.members?.length === 2 &&
    summary.members.includes(agent)
  );
}
