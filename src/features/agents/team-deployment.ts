import { sameCommunityAgents } from "./choices";
import type { TeamSnapshot } from "./team-bundles";
import type { AgentControl } from "./control";
import type { Team } from "../channel-templates/model";
import type { RelaySession } from "../relay/session";
import {
  addChannelMember,
  startAddedAgent,
  type MemberAdditionIntent,
} from "../channel-members/members";
export interface TeamDeployment {
  team: Team;
  channelId: string;
  additions: MemberAdditionIntent[];
}
export function teamDeployment(team: Team, channelId: string): TeamDeployment {
  return {
    team: structuredClone(team),
    channelId,
    additions: team.agents.map(() => ({})),
  };
}
/** Deploy reuses exact saved copies. Only explicit import creates new identities. */
export async function deployTeam(
  control: AgentControl | undefined,
  session: RelaySession,
  attempt: TeamDeployment,
  signal: AbortSignal,
  snapshot?: TeamSnapshot,
) {
  const failures: string[] = [];
  for (const [index, pubkey] of attempt.team.agents.entries()) {
    signal.throwIfAborted();
    try {
      await control?.refresh();
      signal.throwIfAborted();
      let agent = sameCommunityAgents(
        control?.snapshot().data?.agents ?? [],
        session.scope,
      ).find((agent) => agent.pubkey === pubkey);
      if (snapshot) {
        if (!session.viewer || !agent || !control?.applyTeamInstructions)
          throw new Error("A portable team member is unavailable locally");
        const result = await control.applyTeamInstructions(
          agent.id,
          agent.revision,
          snapshot.team.instructions ?? "",
          attempt.team.id,
          session.scope.slice(0, -(session.viewer.length + 1)),
        );
        signal.throwIfAborted();
        agent = result.agents.find((item) => item.id === agent?.id);
        if (!agent)
          throw new Error("A portable team member is unavailable locally");
        if (
          agent.status === "running" &&
          agent.runningRevision !== agent.revision
        ) {
          const restarted = await control.action(agent.id, "restart");
          const current = restarted.agents.find(
            (item) => item.id === agent?.id,
          );
          if (
            !current ||
            !["running", "waiting", "starting"].includes(current.status)
          )
            throw new Error(current?.error ?? "Team member did not restart");
        }
      }
      signal.throwIfAborted();
      if (agent?.profilePending) {
        if (!control?.publishProfile)
          throw new Error("Profile publication is unavailable");
        await control.publishProfile(agent.id);
      }
      await addChannelMember(
        session,
        attempt.channelId,
        pubkey,
        signal,
        attempt.additions[index],
      );
      await startAddedAgent(
        control,
        session,
        attempt.channelId,
        pubkey,
        signal,
        true,
      );
    } catch (error) {
      failures.push(
        `${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
