import { useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { UsersIcon } from "../../shared/design-system/icons";

/** Unknown classification is not evidence of a private conversation. Only a
 * verified current roster plus a known non-agent profile supplies Shared. */
export function useSharedWithPeople(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const roles = useSyncExternalStore(
    session.memberAdministration.subscribe,
    () =>
      channel ? session.memberAdministration.snapshot(channel.id) : undefined,
  );
  const human =
    !channel?.cached &&
    channel?.members?.some((key) => {
      const profile = profiles.get(key);
      return (
        key !== session.viewer &&
        roles?.authority.roles[key] !== "bot" &&
        profile &&
        !profile.isAgent &&
        !profile.nameIsFallback &&
        !agents.identities.some((agent) => agent.pubkey === key)
      );
    });
  return !!human;
}

/** Status only: the chat's actions menu owns access management. The row's
 * select button names it through `soloSharedMarkId`. */
export const soloSharedMarkId = (channelId: string) =>
  `solo-shared-${channelId}`;

export function ChatSharedMark({
  session,
  channel,
}: {
  session: RelaySession;
  channel: ChannelSummary | undefined;
}) {
  if (!useSharedWithPeople(session, channel)) return null;
  return (
    <span id={channel && soloSharedMarkId(channel.id)} data-solo-shared="">
      <UsersIcon size={16} aria-hidden="true" />
      <span className="sr-only">Shared</span>
    </span>
  );
}
