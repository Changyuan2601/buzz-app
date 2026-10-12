import { useSyncExternalStore } from "react";
import type { Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { workingAgents } from "./working-agents";

const noSubscribe = () => () => {};
const noAgents: readonly string[] = [];
const noProfiles = new Map<string, Profile>();

/** Shared observer/owned-typing signal for Messages and Me sidebar rows. */
export function useWorkingAgents(
  session: RelaySession,
  channelId: string,
  working: boolean,
) {
  const agentKeys = useSyncExternalStore(
    working ? session.agentActivity.subscribe : noSubscribe,
    () =>
      working
        ? workingAgents(session.agentActivity.snapshot(), channelId).join(",")
        : "",
  );
  // App-managed agents publish no observer telemetry, so typing in this channel
  // or any of its threads is their working signal. Only the viewer's own agents
  // count: the library, not other people's self-declared profile hints.
  const typingKeys = useSyncExternalStore(session.typing.subscribe, () =>
    [
      ...new Set(
        session.typing
          .snapshot()
          .filter((entry) => entry.channelId === channelId)
          .map((entry) => entry.pubkey),
      ),
    ].join(","),
  );
  const observed = agentKeys ? agentKeys.split(",") : noAgents;
  const typers = typingKeys ? typingKeys.split(",") : noAgents;
  const library = useSyncExternalStore(
    typers.length ? session.agentChoices.subscribe : noSubscribe,
    typers.length ? session.agentChoices.snapshot : () => undefined,
  );
  const typingAgents = typers.filter((key) =>
    library?.identities.some((identity) => identity.pubkey === key),
  );
  const agents = typingAgents.length
    ? [...new Set([...observed, ...typingAgents])].sort()
    : observed;
  const agentProfiles = useSyncExternalStore(
    agents.length ? session.profiles.subscribe : noSubscribe,
    agents.length ? session.profiles.snapshot : () => noProfiles,
  );
  return { agents, agentProfiles };
}
