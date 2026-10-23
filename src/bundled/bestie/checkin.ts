import type { AgentClient, RemoteAgent } from "../builderlab/agents/client";

type Beekeeper = Pick<AgentClient, "beekeeper">;

/** Turns on Bestie's hourly check-in in `channelId`, a relay workflow
 * Beekeeper signs with Bestie's key. Always deletes and re-saves the
 * workflow, so calling it again is the retry. */
export async function enableCheckIn(
  agents: Beekeeper,
  agent: Pick<RemoteAgent, "id">,
  community: string,
  channelId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!agent.id.trim()) throw new Error("Agent ID is unavailable.");
  const result = await agents.beekeeper(
    "enable-bestie",
    { agent_id: agent.id, community_url: community, channel_id: channelId },
    signal,
  );
  confirm(result, "Builderlab could not turn on Bestie's check-in.");
}

/** Turns off Bestie's hourly check-in. Succeeds when there was none. */
export async function disableCheckIn(
  agents: Beekeeper,
  agent: Pick<RemoteAgent, "id">,
  community: string,
  signal: AbortSignal,
): Promise<void> {
  if (!agent.id.trim()) throw new Error("Agent ID is unavailable.");
  const result = await agents.beekeeper(
    "disable-bestie",
    { agent_id: agent.id, community_url: community },
    signal,
  );
  confirm(result, "Builderlab could not turn off Bestie's check-in.");
}

function confirm(result: Record<string, unknown>, fallback: string) {
  if (result.status === "succeeded") return;
  throw new Error(
    typeof result.error_message === "string" && result.error_message
      ? result.error_message
      : fallback,
  );
}
