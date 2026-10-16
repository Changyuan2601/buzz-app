// Teams in config channels (plan §6): a team's id, channel and `buzz.team`
// revision for an imported old Buzz team or a migrated local team, with
// per-member progress in `buzz.agents.teams.migration.v1` so every step
// resumes after a crash or restart and never resets existing membership.
import { artifactD, expectedTeam, readHead } from "./agent-config-artifacts";
import type { Subject } from "./agent-config";
import {
  agentSubject,
  type ConfigChannels,
  importedTeamId,
  teamSubject,
} from "./config-channels";
import type { ConfigSync } from "./config-sync";
import {
  edited,
  migrate,
  save,
  type Saved,
  type WriteDeps,
} from "./config-writes";
import type { Team } from "./store";

export const TEAMS_MIGRATION_KEY = "buzz.agents.teams.migration.v1";

export type TeamMigration = Readonly<{
  localTeamId: string;
  community: string;
  status: "pending" | "unsupported" | "failed" | "confirmed";
  /** UUIDv5 per §6.3, computed before any write. */
  teamId: string;
  channelId?: string;
  artifactEventId?: string;
  intendedMembers: readonly string[];
  addedMembers: readonly string[];
  pendingMembers: readonly string[];
  /** Where it came from, and what it publishes, so a stopped move resumes
   * from the journal alone (absent on entries written before either). */
  source?: Source["kind"];
  team?: Readonly<{ name: string; instructions: string }>;
  error?: string;
}>;

const key = (community: string, localTeamId: string) =>
  `${community}\n${localTeamId}`;

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
  private entries: Record<string, TeamMigration> = {};
  private discovered: Record<string, readonly KnownTeam[]> = {};
  constructor(private readonly storage: Storage = localStorage) {
    try {
      const value = JSON.parse(
        storage.getItem(TEAMS_MIGRATION_KEY) ?? "null",
      ) as { version?: unknown; entries?: unknown; known?: unknown } | null;
      if (
        value?.version === 1 &&
        value.entries &&
        typeof value.entries === "object"
      )
        this.entries = value.entries as Record<string, TeamMigration>;
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
  get = (community: string, localTeamId: string) =>
    this.entries[key(community, localTeamId)];
  all = () => Object.values(this.entries);
  /** Persisted before the caller's next relay write. */
  put(entry: TeamMigration) {
    this.entries[key(entry.community, entry.localTeamId)] = entry;
    this.persist();
    return entry;
  }
  /** The teams discovery last found for `owner` in `community`, undefined
   * if none did: they keep deciding starts while the community is
   * unavailable. */
  /** Whether `id` is a synced team: one journaled here, or one discovery
   * found, from any device. A local team's id is never either. */
  synced = (id: string) =>
    this.all().some((entry) => entry.teamId === id) ||
    Object.values(this.discovered).some((teams) =>
      teams.some((team) => team.id === id),
    );
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
    this.persist();
  }
  private persist() {
    this.storage.setItem(
      TEAMS_MIGRATION_KEY,
      JSON.stringify({
        version: 1,
        entries: this.entries,
        known: this.discovered,
      }),
    );
  }
}

export type TeamDeps = Readonly<{
  channels: Pick<
    ConfigChannels,
    "find" | "teams" | "ensure" | "addMember" | "removeMember" | "owns"
  >;
  sync: Pick<ConfigSync, "bind">;
  writes: WriteDeps;
  journal: TeamJournal;
  owner: string;
  community: string;
  /** The community's UUID (NIP-11 `read_state_snapshot.community_id`), which
   * an imported team's id is derived from; absent, teams can't move here. */
  communityId: string | undefined;
}>;

/** Where a team comes from. `new`: created in the Teams tab, with a freshly
 * minted UUID as its id; the others get their UUIDv5 import id (§6.3). */
export type Source = Readonly<{
  kind: "old-buzz-team" | "local-team" | "new";
  id: string;
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

/** Moves a team into its config channel: ensure → publish → add members.
 * Resumes from the journal entry for `source`. `archived` means only an
 * archived copy exists: the caller offers Recover, and nothing is created. */
export async function publishTeam(
  deps: TeamDeps,
  source: Source,
  team: Pick<Team, "name" | "instructions" | "members">,
): Promise<
  | TeamMigration
  | Readonly<{ status: "archived"; teamId: string; channelId: string }>
> {
  const { journal, owner, community, communityId } = deps;
  const prior = journal.get(community, source.id);
  // Nothing is journaled, so the move runs once the community's id is known.
  if (!prior && source.kind !== "new" && !communityId)
    return Object.freeze({
      localTeamId: source.id,
      community,
      status: "unsupported",
      teamId: "",
      intendedMembers: [...team.members],
      addedMembers: [],
      pendingMembers: [],
    } satisfies TeamMigration);
  let entry = journal.put(
    prior
      ? {
          ...prior,
          intendedMembers: [
            ...new Set([...prior.intendedMembers, ...team.members]),
          ],
        }
      : {
          localTeamId: source.id,
          community,
          status: "pending",
          teamId:
            source.kind === "new"
              ? source.id
              : await importedTeamId({
                  owner,
                  community: communityId as string,
                  source: source.kind,
                  sourceId: source.id,
                }),
          intendedMembers: [...team.members],
          addedMembers: [],
          pendingMembers: [],
          source: source.kind,
          team: { name: team.name, instructions: team.instructions },
        },
  );
  if (teamComplete(entry)) return entry;
  // The persisted id, never a recomputed one (§6.2).
  const { teamId } = entry;
  try {
    const subject = await teamSubject(teamId);
    if (!entry.channelId) {
      const found = await deps.channels.find(
        "team-config",
        subject,
        deps.writes.signal,
      );
      if (found?.archived)
        return { status: "archived", teamId, channelId: found.id };
      const channel =
        found ??
        (await deps.channels.ensure(
          "team-config",
          subject,
          team.name,
          deps.writes.signal,
        ));
      entry = journal.put({ ...entry, channelId: channel.id });
    }
    const channel = entry.channelId as string;
    await deps.sync.bind([{ family: "team-config", subject: teamId, channel }]);
    if (entry.status !== "confirmed") {
      const type = "buzz.team" as const;
      const artifact: Subject = {
        owner,
        community,
        subject: teamId,
        channel,
        type,
      };
      const migrated = await migrate(deps.writes, {
        subject: artifact,
        expected: {
          channel,
          type,
          d: await artifactD(type, channel),
          team: teamId,
        },
        title: team.name,
        extra: [
          ["team", teamId],
          ...(source.kind === "new"
            ? []
            : [["imported-from", `${source.kind}:${source.id}`]]),
        ],
        content: () =>
          JSON.stringify({
            version: 1,
            name: team.name,
            instructions: team.instructions,
          }),
        strip() {},
      });
      // Adopted, superseded or blocked by a newer head: the channel's team
      // stands; this device's copy is never written over it.
      if (
        !["confirmed", "adopted", "superseded", "blocked"].includes(
          migrated.status,
        )
      )
        return journal.put({
          ...entry,
          status: "failed",
          error: migrated.error ?? "The team hasn't published yet",
        });
      entry = journal.put({
        ...entry,
        status: "confirmed",
        ...(migrated.eventId ? { artifactEventId: migrated.eventId } : {}),
      });
    }
    return await addMembers(deps, entry);
  } catch (error) {
    return journal.put({
      ...entry,
      status: entry.status === "confirmed" ? "confirmed" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Adds each intended member not yet added whose agent channel exists; the
 * rest wait in `pendingMembers` and are retried by the next call. */
async function addMembers(deps: TeamDeps, start: TeamMigration) {
  let entry = start;
  const channel = entry.channelId as string;
  for (const pubkey of entry.intendedMembers) {
    if (entry.addedMembers.includes(pubkey)) continue;
    const own = await deps.channels
      .find("agent-config", agentSubject(pubkey), deps.writes.signal)
      .catch(() => undefined);
    // A throw is as unconfirmed as an uncertain or failed result.
    const added =
      own && !own.archived
        ? await deps.channels
            .addMember(channel, pubkey, deps.writes.signal)
            .catch(() => undefined)
        : undefined;
    entry = deps.journal.put(
      added?.status === "confirmed"
        ? {
            ...entry,
            addedMembers: [...entry.addedMembers, pubkey],
            pendingMembers: entry.pendingMembers.filter((p) => p !== pubkey),
          }
        : {
            ...entry,
            pendingMembers: [...new Set([...entry.pendingMembers, pubkey])],
          },
    );
  }
  return entry;
}

/** Whether the team is made: confirmed, with every intended member added. */
export const teamComplete = (
  entry: Pick<TeamMigration, "status" | "intendedMembers" | "addedMembers">,
) =>
  entry.status === "confirmed" &&
  entry.intendedMembers.every((p) => entry.addedMembers.includes(p));

/** Whether the local row may go: confirmed, with every intended member added
 * or durably pending in the journal. */
export const retired = (entry: TeamMigration | undefined) =>
  entry?.status === "confirmed" &&
  entry.intendedMembers.every(
    (p) => entry.addedMembers.includes(p) || entry.pendingMembers.includes(p),
  );

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
      deps.journal
        .all()
        .find(
          (entry) =>
            entry.community === deps.community &&
            entry.channelId === channel.id,
        )?.teamId;
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

/** Edits a synced team: a revision of `base`, the head its editor opened,
 * for its name and instructions, and channel membership for its members.
 * `failed` lists each member change not confirmed. */
export async function editTeam(
  deps: TeamDeps,
  team: SyncedTeam,
  change: Pick<Team, "name" | "instructions" | "members">,
  base: string | null = team.head ?? null,
): Promise<Readonly<{ saved?: Saved; failed: readonly string[] }>> {
  const head = deps.writes.store.state(team.subject).head;
  const content = edited(head, {
    version: 1,
    name: change.name,
    instructions: change.instructions,
  });
  const saved =
    content === head?.content
      ? undefined
      : await save(
          deps.writes,
          {
            subject: team.subject,
            title: change.name,
            expected: {
              channel: team.channel,
              type: "buzz.team",
              d: await artifactD("buzz.team", team.channel),
              team: team.id,
            },
          },
          content,
          [["team", team.id]],
          base,
        );
  const failed: string[] = [];
  for (const pubkey of change.members.filter((p) => !team.members.includes(p)))
    if (
      (await deps.channels.addMember(team.channel, pubkey, deps.writes.signal))
        .status !== "confirmed"
    )
      failed.push(pubkey);
  for (const pubkey of team.members.filter((p) => !change.members.includes(p)))
    if (
      (await deps.channels.removeMember(team.channel, pubkey)).status !==
      "confirmed"
    )
      failed.push(pubkey);
  return { ...(saved ? { saved } : {}), failed };
}
