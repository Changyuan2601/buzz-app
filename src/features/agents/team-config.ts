// Teams in config channels (plan §6): the synced teams discovery finds, kept
// in `buzz.agents.teams.migration.v1` so they keep deciding starts while the
// community is unavailable. Team writes are `team-ops.ts`'s.
import { artifactD, expectedTeam, readHead } from "./agent-config-artifacts";
import type { Subject } from "./agent-config";
import type { ConfigChannels } from "./config-channels";
import type { ConfigSync } from "./config-sync";
import type { WriteDeps } from "./config-writes";
import type { Team } from "./store";
import type { TeamOps } from "./team-ops";

export const TEAMS_MIGRATION_KEY = "buzz.agents.teams.migration.v1";

const key = (community: string, owner: string) => `${community}\n${owner}`;

/** A synced team as discovery last found it, kept on this device. */
export type KnownTeam = Omit<SyncedTeam, "subject">;

const isKnownTeam = (value: unknown): value is KnownTeam => {
  const team = value as Partial<Record<keyof KnownTeam, unknown>> | null;
  return (
    !!team &&
    typeof team.id === "string" &&
    typeof team.channel === "string" &&
    typeof team.archived === "boolean" &&
    typeof team.unreadable === "boolean" &&
    (team.head === undefined || typeof team.head === "string") &&
    Array.isArray(team.members) &&
    team.members.every((member) => typeof member === "string")
  );
};

export class TeamJournal {
  private discovered: Record<string, readonly KnownTeam[]> = {};
  constructor(private readonly storage: Storage = localStorage) {
    try {
      const value = JSON.parse(
        storage.getItem(TEAMS_MIGRATION_KEY) ?? "null",
      ) as { version?: unknown; known?: unknown } | null;
      if (
        value?.version === 1 &&
        value.known &&
        typeof value.known === "object"
      )
        for (const [at, teams] of Object.entries(value.known))
          if (Array.isArray(teams) && teams.every(isKnownTeam))
            this.discovered[at] = teams;
    } catch {
      /* Start fresh after malformed local data. */
    }
  }
  /** Whether discovery found a relay team with `id` for any owner or
   * community. A local row may share the id; which copy a run uses is
   * decided by `known()` for that run's owner and community. */
  synced = (id: string) =>
    Object.values(this.discovered).some((teams) =>
      teams.some((team) => team.id === id),
    );
  /** The teams discovery last found for `owner` in `community`, undefined
   * if none did: they keep deciding starts while the community is
   * unavailable. */
  known(owner: string, community: string): readonly SyncedTeam[] | undefined {
    return this.discovered[key(community, owner)]?.map((team) => ({
      ...team,
      subject: {
        owner,
        community,
        subject: team.id,
        channel: team.channel,
        type: "buzz.team",
      },
    }));
  }
  remember(owner: string, community: string, teams: readonly SyncedTeam[]) {
    this.discovered[key(community, owner)] = teams.map(
      ({ subject: _, ...team }) => team,
    );
    this.storage.setItem(
      TEAMS_MIGRATION_KEY,
      JSON.stringify({ version: 1, known: this.discovered }),
    );
  }
}

export type TeamDeps = Readonly<{
  channels: Pick<ConfigChannels, "teams" | "owns">;
  sync: Pick<ConfigSync, "bind">;
  writes: Pick<WriteDeps, "read" | "signal">;
  /** Team changes in flight: a channel one made names its team. */
  ops: TeamOps;
  owner: string;
  community: string;
}>;

/** Where a local team can move: the one community all its members share, or
 * `spans` when they are in more than one (it stays on this device). */
export function teamCommunity(
  team: Pick<Team, "members">,
  communityOf: (pubkey: string) => string | undefined,
): string | "spans" | undefined {
  const communities = new Set(team.members.map(communityOf));
  if (communities.size !== 1) return communities.size ? "spans" : undefined;
  const [only] = communities;
  return only ?? "spans";
}

export const UNREADABLE_TEAM =
  "This team can't be read right now, so its agents wait to start";

/** A team head's name and instructions, or undefined when it isn't one. */
export function teamBody(content: string) {
  try {
    const body = JSON.parse(content) as Record<string, unknown>;
    return typeof body.name === "string" &&
      typeof body.instructions === "string"
      ? { name: body.name, instructions: body.instructions }
      : undefined;
  } catch {
    return undefined;
  }
}

export const SPANS_NOTE =
  "This team's agents are in different communities, so it stays on this device";

/** A team config channel this owner has, with its team id proven by the
 * channel's subject label. Name and instructions are its synced head's.
 * `unreadable`: its head can't be read now, so its members' starts wait. */
export type SyncedTeam = Readonly<{
  id: string;
  channel: string;
  archived: boolean;
  unreadable: boolean;
  subject: Subject;
  /** The id of the head discovery read: an edit without its own base
   * revises this one. */
  head?: string;
  /** The channel's agents this owner attests to (NIP-OA); anyone else in it
   * is never treated, or removed, as a team member. */
  members: readonly string[];
}>;

const teamArtifact = (
  deps: TeamDeps,
  id: string,
  channel: string,
): Subject => ({
  owner: deps.owner,
  community: deps.community,
  subject: id,
  channel,
  type: "buzz.team",
});

/** Every team config channel of this owner's, bound for sync. A channel
 * whose head can't prove its team keeps the id an earlier discovery found
 * for it (`known`), as unreadable; one never found is skipped, never
 * guessed. */
export async function discoverTeams(
  deps: TeamDeps,
  known: readonly SyncedTeam[] = [],
): Promise<SyncedTeam[]> {
  const { signal } = deps.writes;
  const found: SyncedTeam[] = [];
  const owned = new Map<string, Promise<boolean>>();
  const owns = (pubkey: string) => {
    let proof = owned.get(pubkey);
    if (!proof) {
      proof = deps.channels.owns(pubkey, signal).catch(() => false);
      owned.set(pubkey, proof);
    }
    return proof;
  };
  for (const channel of await deps.channels.teams(signal)) {
    const head = await readHead(
      deps.writes.read,
      channel.id,
      await artifactD("buzz.team", channel.id),
      signal,
    ).catch(() => undefined);
    const claimed = head?.tags.find((t) => t[0] === "team")?.[1];
    const proven =
      claimed &&
      (await expectedTeam(claimed, channel.label).catch(() => undefined));
    const prior = known.find((team) => team.channel === channel.id);
    const id =
      proven ||
      prior?.id ||
      deps.ops
        .all(deps.owner, deps.community)
        .find((op) => op.channel === channel.id)?.teamId;
    if (!id) continue;
    if (!channel.archived)
      await deps.sync.bind([
        { family: "team-config", subject: id, channel: channel.id },
      ]);
    const occupants = (channel.members ?? []).filter((p) => p !== deps.owner);
    const members: string[] = [];
    for (const pubkey of occupants)
      if (prior?.members.includes(pubkey) || (await owns(pubkey)))
        members.push(pubkey);
    found.push({
      id,
      channel: channel.id,
      archived: channel.archived,
      unreadable: !proven,
      subject: teamArtifact(deps, id, channel.id),
      ...(proven && head ? { head: head.id } : {}),
      members: channel.members ? members : (prior?.members ?? []),
    });
  }
  return found;
}
