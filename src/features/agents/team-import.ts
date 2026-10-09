import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import { encodeTeamPayload } from "../channel-templates/team-payload";
import {
  importTeamMembers,
  resumeTeamImport,
  type TeamSnapshot,
} from "./team-bundles";

export interface TeamImportOptions {
  destination: string;
  owner: string;
  keepAllowlist: boolean;
  restoreMemory?: boolean;
}
/** One shared explicit import path for file previews, direct sharing and catalog adoption. */
export async function importTeamSnapshot(
  control: AgentControl,
  kit: ChannelKit,
  snapshot: TeamSnapshot,
  options: TeamImportOptions,
) {
  if (!control.previewTeam) throw new Error("Team preview is unavailable");
  const validated = await control.previewTeam(JSON.stringify(snapshot));
  const receipt = await resumeTeamImport(
    validated,
    options.destination,
    options.owner,
    "",
    options.keepAllowlist,
  );
  await encodeTeamPayload(
    validated,
    options.destination,
    options.owner,
    receipt.id,
    receipt.id,
  );
  const agents = await importTeamMembers(
    control,
    validated,
    receipt.requests,
    options.destination,
    options.owner,
    options.keepAllowlist,
    receipt.id,
  );
  const failures: string[] = [];
  for (const agent of agents) {
    if (!agent.profilePending) continue;
    try {
      if (!control.publishProfile)
        throw new Error("Profile publication is unavailable");
      await control.publishProfile(agent.id);
    } catch (error) {
      failures.push(
        `${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  await kit.refresh();
  const existing = kit
    .snapshot()
    .entries.find(
      (entry) =>
        entry.record.value.type === "team" &&
        entry.record.value.id === receipt.id,
    );
  if (
    existing?.record.value.type !== "team" ||
    existing.record.value.portable?.revision !== receipt.id
  ) {
    await kit.savePortable(
      {
        type: "team",
        id: receipt.id,
        name: validated.team.name,
        agents: agents.map((agent) => agent.pubkey),
      },
      validated,
      existing?.eventId,
      receipt.id,
    );
  }
  const memories: {
    pubkey: string;
    written: number;
    total: number;
    errors: string[];
  }[] = [];
  if (options.restoreMemory) {
    if (!control.writeSnapshotMemory)
      throw new Error("Memory restoration is unavailable");
    for (const [index, agent] of agents.entries()) {
      const memory = validated.members[index]?.memory;
      if (!memory?.entries?.length) continue;
      try {
        const result = await control.writeSnapshotMemory(
          agent.id,
          memory.entries,
        );
        memories.push({
          pubkey: agent.pubkey,
          ...result,
          total: result.total ?? memory.entries.length,
        });
      } catch (error) {
        memories.push({
          pubkey: agent.pubkey,
          written: 0,
          total: memory.entries.length,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
  }
  if (!memories.some((member) => member.errors.length)) receipt.complete();
  return { id: receipt.id, agents, memories };
}
