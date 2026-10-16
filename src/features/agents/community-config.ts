// Wires config channels into one bound community (plan §5, §12 step 9): the
// relay's support check, then per agent `ensure` its config channel, bind
// sync to it, and migrate each type. Off until every ship gate holds (§1.2);
// tests turn it on through `enabled`.
import type { RelaySession } from "../relay/session";
import { readSnapshotCommunity } from "../relay/read-state-snapshot";
import {
  type AgentConfigStore,
  pickSettings,
  type SettingsSchema,
  type Subject,
} from "./agent-config";
import {
  type ArtifactType,
  artifactD,
  type artifactTemplate,
} from "./agent-config-artifacts";

type ArtifactTemplate = ReturnType<typeof artifactTemplate>;
import type { Mode, TeamSource } from "./agent-start";
import {
  agentSubject,
  configSupport,
  createConfigChannels,
} from "./config-channels";
import type { RelayEvent } from "../relay/events";
import {
  begin,
  type Lifecycle,
  type LifecycleJournal,
  type LifecycleDeps,
  observe,
  resumeAll,
} from "./config-lifecycle";
import {
  type ConfigSync,
  createConfigSync,
  type SyncProblem,
} from "./config-sync";
import {
  edited,
  headFields,
  type LocalSide,
  type MigrationJournal,
  MODE,
  migrate,
  refresh,
  resume,
  revise,
  type Saved,
  save,
  type WriteDeps,
} from "./config-writes";
import { sessionConfigFeed } from "./session-config-feed";
import type { Team } from "./store";
import {
  discoverTeams,
  editTeam,
  publishTeam,
  type Source,
  retired,
  type SyncedTeam,
  teamComplete,
  type TeamDeps,
  type TeamJournal,
  teamCommunity,
} from "./team-config";

/** Config sync ships off. Turning it on is a one-line change. */
export const CONFIG_SYNC_ENABLED = false;

/** One agent this device runs, as config migration needs it. Hosted agents
 * are never passed: they get no config channel (T16). */
export type ConfigAgent = Readonly<{
  pubkey: string;
  name: string;
  type: string;
  config: object;
  /** The type's synced settings allowlist; without it settings stay local. */
  schema?: SettingsSchema | undefined;
}>;

export type Side = "settings" | "instructions";
const SIDES: readonly Side[] = ["settings", "instructions"];
const TYPE: Record<Side, ArtifactType> = {
  settings: "buzz.agent.settings",
  instructions: "buzz.agent.instructions",
};
const TITLE: Record<Side, string> = {
  settings: "Agent settings",
  instructions: "Agent instructions",
};

/** The artifact content each side publishes from a config, over `head`'s
 * fields and settings this client doesn't know (NIP-AP "Editing"). */
export function content(
  side: Side,
  agent: ConfigAgent,
  config: object,
  head?: RelayEvent,
) {
  if (side === "instructions") {
    const text = (config as { instructions?: unknown }).instructions;
    return edited(head, {
      version: 1,
      text: typeof text === "string" ? text : "",
    });
  }
  const schema = agent.schema ?? {};
  const { settings } = headFields(head);
  const kept =
    settings && typeof settings === "object"
      ? Object.fromEntries(
          Object.entries(settings).filter(([name]) => !(name in schema)),
        )
      : {};
  return edited(head, {
    version: 1,
    agentType: agent.type,
    settings: { ...kept, ...pickSettings(schema, config) },
  });
}

/** Whether an edit carries the side's fields. A retired local field is
 * absent, never an edit to empty. */
const edits = (side: Side, agent: ConfigAgent, config: object) =>
  side === "instructions"
    ? "instructions" in config
    : Object.keys(agent.schema ?? {}).some((name) => name in config);

export type AgentBinding = Partial<
  Record<Side, Readonly<{ mode: Mode; subject: Subject }>>
> &
  Readonly<{ teams?: readonly TeamSource[] }>;

/** The head each synced side's editor opened; `null`: it opened none. */
export type ConfigBase = Partial<Record<Side, RelayEvent | null>>;

/** This device's journals, owned by the app so they outlive any one live
 * community: a binding the migration journal recorded keeps deciding starts,
 * Delete and edits while the community is reconnecting or unsupported. */
export type ConfigJournals = Readonly<{
  migration: MigrationJournal;
  teams: TeamJournal;
  lifecycle: LifecycleJournal;
}>;

/** The binding the migration journal persisted for the agent, or undefined
 * when it never migrated in this community. With no live community it still
 * decides starts: a synced side starts only from its confirmed copy (§4.4). */
export function storedBinding(
  journals: Pick<ConfigJournals, "migration" | "teams">,
  owner: string,
  community: string,
  pubkey: string,
): AgentBinding | undefined {
  const binding: Partial<Record<Side, { mode: Mode; subject: Subject }>> = {};
  for (const side of SIDES) {
    const subject = { owner, community, subject: pubkey, type: TYPE[side] };
    const entry = journals.migration.get({ ...subject, channel: "" });
    if (entry)
      binding[side] = {
        mode: MODE[entry.status],
        subject: { ...subject, channel: entry.channelId },
      };
  }
  return Object.keys(binding).length
    ? {
        ...binding,
        ...teamSources(journals.teams.known(owner, community), pubkey),
      }
    : undefined;
}

/** The teams whose channel lists the agent, as the resolver admits them;
 * none while teams aren't known, so they stay local. */
function teamSources(
  teams: readonly SyncedTeam[] | undefined,
  pubkey: string,
): { teams?: TeamSource[] } {
  if (!teams) return {};
  const sources: TeamSource[] = teams
    .filter((team) => team.members.includes(pubkey))
    .map((team) => ({
      id: team.id,
      lifecycle: team.archived
        ? "archived"
        : team.unreadable
          ? "unreadable"
          : "active",
      subject: team.subject,
      members: team.members,
    }));
  return { teams: sources };
}

export type CommunityConfigInput = Readonly<{
  session: RelaySession;
  owner: string;
  community: string;
  store: AgentConfigStore;
  journals: ConfigJournals;
  /** The relay's NIP-11 document. */
  info(signal: AbortSignal): Promise<unknown>;
  /** Removes a side's local field once its exact value is the synced head;
   * given `accepted`, only if the local value is exactly that head. */
  strip(pubkey: string, side: Side, accepted?: RelayEvent): void;
  /** Reports each binding change, so starts and the UI re-resolve. */
  changed(): void;
  enabled?: boolean;
}>;

/** Null when config sync is off or this session can't hold it. Otherwise
 * resolves once the support check passes; unsupported relays give null. */
export async function communityConfig(
  input: CommunityConfigInput,
  signal: AbortSignal,
) {
  const { session, owner, community, store } = input;
  if (!(input.enabled ?? CONFIG_SYNC_ENABLED)) return null;
  const writer = session.configArtifactWriter;
  const feed = sessionConfigFeed(session);
  if (!writer || !feed) return null;
  const info = await input.info(signal).catch(() => null);
  const support = configSupport(info);
  if (!support.supported || signal.aborted) {
    feed.dispose();
    return null;
  }
  // Sync reports into the configs built from it.
  let configs: CommunityConfig | undefined;
  const sync = createConfigSync(store, feed, owner, community, {
    discovery: (metadata) => configs?.discovered(metadata),
    rediscovered: () => void configs?.reconnected(),
    problem: (problem) => configs?.problem(problem),
    history: (channel, d) => configs?.historyChanged(channel, d),
    roster: (channel) => configs?.rosterChanged(channel),
  });
  configs = agentConfigs({
    channels: createConfigChannels(session, owner, feed),
    sync,
    deps: {
      read: feed.read,
      writer,
      store,
      journal: input.journals.migration,
      maxEventBytes: support.maxEventBytes,
      signal,
    },
    teamJournal: input.journals.teams,
    lifecycle: input.journals.lifecycle,
    owner,
    community,
    communityId: readSnapshotCommunity(
      (info as { read_state_snapshot?: unknown } | null)?.read_state_snapshot,
    ),
    strip: input.strip,
    changed: input.changed,
    dispose: feed.dispose,
  });
  return configs;
}

/** Per-agent config channels over one community's sync and writers. */
export function agentConfigs(
  input: Readonly<{
    channels: TeamDeps["channels"] & LifecycleDeps["channels"];
    sync: Pick<ConfigSync, "bind" | "unbind" | "dispose">;
    deps: WriteDeps;
    teamJournal: TeamJournal;
    lifecycle: LifecycleJournal;
    owner: string;
    community: string;
    communityId?: string | undefined;
    strip(pubkey: string, side: Side, accepted?: RelayEvent): void;
    changed(): void;
    dispose?(): void;
  }>,
) {
  const { channels, sync, deps, owner, community } = input;
  const { store, journal, signal } = deps;
  const bindings = new Map<string, AgentBinding>();
  /** Each agent's run in flight; runs chain, so two never race a journal. */
  const running = new Map<string, Promise<void>>();
  /** Agents whose attach ran. Only a connection, a discovery or the archive
   * lifecycle runs one again, so a failing relay is retried boundedly. */
  const attached = new Set<string>();
  const configs = new Map<string, ConfigAgent>();
  /** Each attached agent's selected config channel. */
  const channelOf = new Map<string, string>();
  /** Each attached agent's sides in its selected channel, for History. */
  const sidesOf = new Map<string, ReadonlyMap<Side, LocalSide>>();
  /** How often each artifact's history changed without a new head, by
   * `channel d`, so History reloads after a redaction (§1.2). */
  const versions = new Map<string, number>();
  const life: LifecycleDeps = {
    channels,
    journal: input.lifecycle,
    community,
    ...(signal ? { signal } : {}),
  };
  const teamDeps: TeamDeps = {
    channels,
    sync,
    writes: deps,
    journal: input.teamJournal,
    owner,
    community,
    communityId: input.communityId,
  };
  /** Until a discovery completes, the teams the last one found here;
   * undefined while none ever did, so teams stay local. */
  let teams = input.teamJournal.known(owner, community);
  async function refreshTeams() {
    const found = await discoverTeams(teamDeps, teams);
    if (disposed) return;
    teams = found;
    input.teamJournal.remember(owner, community, found);
    input.changed();
  }
  let disposed = false;

  async function sides(agent: ConfigAgent, channel: string) {
    const which: Side[] = agent.schema
      ? ["settings", "instructions"]
      : ["instructions"];
    return Promise.all(
      which.map(async (side): Promise<[Side, LocalSide]> => {
        const type = TYPE[side];
        const subject: Subject = {
          owner,
          community,
          subject: agent.pubkey,
          channel,
          type,
        };
        return [
          side,
          {
            subject,
            expected: { channel, type, d: await artifactD(type, channel) },
            title: TITLE[side],
            content: () =>
              content(side, agent, configs.get(agent.pubkey)?.config ?? {}),
            strip: (accepted) => input.strip(agent.pubkey, side, accepted),
          },
        ];
      }),
    );
  }

  function record(pubkey: string, side: Side, subject: Subject, mode: Mode) {
    if (disposed) return;
    bindings.set(pubkey, {
      ...bindings.get(pubkey),
      [side]: { mode, subject },
    });
    input.changed();
  }

  async function run(agent: ConfigAgent, recovered: boolean) {
    const channel = await channels.ensure(
      "agent-config",
      agentSubject(agent.pubkey),
      `${agent.name} config`,
      signal,
    );
    if (disposed) return;
    const before = channelOf.get(agent.pubkey);
    if (before && before !== channel.id) {
      // Another, older channel is selected now: sync follows it.
      sync.unbind(before);
      bindings.delete(agent.pubkey);
    }
    channelOf.set(agent.pubkey, channel.id);
    // The channel's archive state holds whoever set it (§8.1); its config
    // stays unbound while archived.
    if (
      observe(life, agent.pubkey, channel.id, channel.archived) !== "active"
    ) {
      bindings.delete(agent.pubkey);
      input.changed();
      return;
    }
    // The agent reads its own config (NIP-AP §2), so it is a member first.
    const member = await channels.addMember(channel.id, agent.pubkey, signal);
    if (member.status !== "confirmed")
      throw new Error(member.error ?? "The agent's membership is unconfirmed");
    await sync.bind([
      { family: "agent-config", subject: agent.pubkey, channel: channel.id },
    ]);
    const found = await sides(agent, channel.id);
    sidesOf.set(agent.pubkey, new Map(found));
    for (const [side, local] of found) {
      const before = journal.get(local.subject)?.status ?? "pending";
      record(agent.pubkey, side, local.subject, MODE[before]);
      const entry = await migrate(deps, local);
      // Resends a save a lost connection or a restart left unresolved.
      await resume(deps, local);
      // A recovered channel may have moved on while archived.
      if (recovered) await refresh(deps, local);
      record(agent.pubkey, side, local.subject, MODE[entry.status]);
    }
  }

  function start(pubkey: string, recovered: boolean) {
    const work: Promise<void> = (running.get(pubkey) ?? Promise.resolve())
      .then(() => {
        const agent = configs.get(pubkey);
        return agent && run(agent, recovered);
      })
      .catch(() => {
        // Stays as it was: retried on the next connection or discovery.
      })
      .finally(() => {
        attached.add(pubkey);
        if (running.get(pubkey) === work) running.delete(pubkey);
        // Its config channel may exist now, so a pending team member can join.
        void resumeTeams();
      });
    running.set(pubkey, work);
    return work;
  }
  const rebind = (pubkey: string, recovered = false) =>
    configs.has(pubkey) ? start(pubkey, recovered) : Promise.resolve();

  async function teamLifecycle(id: string, action: "archive" | "unarchive") {
    const team = teams?.find((t) => t.id === id);
    if (!team || team.archived !== (action === "unarchive"))
      throw new Error("No such team");
    await channels[action](team.channel, signal);
    await refreshTeams();
  }

  /** One team move at a time, so two never race a journal entry. */
  let teamWork = Promise.resolve();
  /** Resumes every team move this community's journal holds unfinished,
   * whether or not its local row is left (§6.2): when agent channels appear
   * and on each connection. */
  function resumeTeams() {
    teamWork = teamWork.then(async () => {
      let moved = false;
      for (const entry of input.teamJournal.all()) {
        if (disposed) return;
        if (entry.community !== community || !entry.teamId) continue;
        const done =
          entry.status === "confirmed" &&
          entry.intendedMembers.every((p) => entry.addedMembers.includes(p));
        // Unpublished, it needs the name and instructions it was made with.
        if (done || (entry.status !== "confirmed" && !entry.team)) continue;
        moved = true;
        await publishTeam(
          teamDeps,
          { kind: entry.source ?? "local-team", id: entry.localTeamId },
          {
            name: entry.team?.name ?? "",
            instructions: entry.team?.instructions ?? "",
            members: entry.intendedMembers,
          },
        ).catch(() => {});
      }
      if (moved && !disposed) await refreshTeams();
    });
    return teamWork.catch(() => {});
  }

  async function resumeLifecycle() {
    const pending = input.lifecycle.pending(community);
    await resumeAll(life);
    for (const { subject } of pending)
      if (input.lifecycle.get(community, subject) === "active")
        await rebind(subject, true);
    input.changed();
  }

  return {
    /** Binds and migrates each agent once; again on reconnect. */
    attach(agents: readonly ConfigAgent[]) {
      return Promise.all(
        agents.map((agent) => {
          configs.set(agent.pubkey, agent);
          if (attached.has(agent.pubkey)) return running.get(agent.pubkey);
          return running.get(agent.pubkey) ?? start(agent.pubkey, false);
        }),
      );
    },
    /** Whether the agent's attach has run, so its binding is decided. */
    settled: (pubkey: string) => attached.has(pubkey) && !running.has(pubkey),
    /** Where the agent is in archive and recover; starts need `active`. */
    lifecycle: (pubkey: string): Lifecycle =>
      input.lifecycle.get(community, pubkey),
    /** Archives the agent's config channel. Starts block from the moment the
     * intent is saved; an unconfirmed one keeps retrying (§8.1). A definite
     * refusal rolls it back, and it binds again behind the barrier. */
    async archive(pubkey: string) {
      const channel = channelOf.get(pubkey);
      if (!channel) throw new Error("Its config channel isn't known yet");
      bindings.delete(pubkey);
      const state = begin(life, pubkey, channel, "archive");
      input.changed();
      const settled = await state;
      if (settled === "active") await rebind(pubkey, true);
      input.changed();
      return settled;
    },
    /** Unarchives it, then binds and migrates it again: the sync barrier. */
    async recover(pubkey: string) {
      const channel = channelOf.get(pubkey);
      if (!channel) throw new Error("Its config channel isn't known yet");
      const state = begin(life, pubkey, channel, "recover");
      input.changed();
      const settled = await state;
      if (settled === "active") await rebind(pubkey, true);
      input.changed();
      return settled;
    },
    /** Retries pending archives and recoveries: on reconnect and restart. */
    resume: resumeLifecycle,
    /** Discovery saw a config channel sync doesn't hold, or a bound one
     * archived: the agent's channel is selected and bound again. */
    discovered(metadata: RelayEvent) {
      const labels = metadata.tags.flatMap(([name, value]) =>
        name === "t" && value ? [value] : [],
      );
      // A team made, archived or recovered elsewhere.
      if (labels.includes("team-config")) void refreshTeams();
      if (!labels.includes("agent-config")) return;
      for (const pubkey of labels)
        if (configs.has(pubkey) && !running.has(pubkey)) void rebind(pubkey);
    },
    /** Each connection retries every agent's selection, migration and held
     * saves, then pending archives and recoveries. */
    async reconnected() {
      await Promise.all([...configs.keys()].map((pubkey) => rebind(pubkey)));
      await resumeLifecycle();
      await resumeTeams();
    },
    resumeTeams,
    /** A team channel's members changed: its cached members are re-read. */
    rosterChanged(channel: string) {
      if (teams?.some((team) => team.channel === channel)) void refreshTeams();
    },
    /** A binding sync couldn't confirm keeps its synced mode, so starts block
     * on the unavailable copy instead of falling back; consumers re-read. */
    problem(_: SyncProblem) {
      input.changed();
    },
    historyChanged(channel: string, d: string) {
      const key = `${channel} ${d}`;
      versions.set(key, (versions.get(key) ?? 0) + 1);
      input.changed();
    },
    /** Each synced side's artifact, for History: what it must be, its current
     * head, and its history's version. */
    history(pubkey: string) {
      const binding = bindings.get(pubkey);
      return SIDES.flatMap((side) => {
        const local = sidesOf.get(pubkey)?.get(side);
        if (binding?.[side]?.mode !== "synced" || !local) return [];
        const { expected, subject } = local;
        return [
          {
            side,
            expected,
            head: store.state(subject).head,
            version: versions.get(`${expected.channel} ${expected.d}`) ?? 0,
          },
        ];
      });
    },
    /** Reads history pages from the config channel. */
    read: deps.read,
    /** Saves a History revert or restore of the agent's `side`, built on
     * the head its `prev` names. */
    revise(pubkey: string, side: Side, template: ArtifactTemplate) {
      const local = sidesOf.get(pubkey)?.get(side);
      const prev = template.tags.find(([name]) => name === "prev")?.[1];
      if (!local || bindings.get(pubkey)?.[side]?.mode !== "synced" || !prev)
        throw new Error("This config isn't synced here");
      return revise(deps, local, template, prev);
    },
    binding(pubkey: string): AgentBinding | undefined {
      const binding = bindings.get(pubkey);
      return binding && { ...binding, ...teamSources(teams, pubkey) };
    },
    /** The synced teams, archived ones included; undefined until known. */
    teams: () => teams,
    refreshTeams,
    /** Moves each local team whose members are all in this community into a
     * config channel, removing its local row once that is safe (§6.2). */
    async migrateTeams(
      local: readonly Team[],
      communityOf: (pubkey: string) => string | undefined,
      remove: (id: string) => void,
      source: (team: Team) => Source = (team) => ({
        kind: "local-team",
        id: team.id,
      }),
    ) {
      for (const team of local) {
        if (teamCommunity(team, communityOf) !== community) continue;
        const entry = await publishTeam(teamDeps, source(team), team);
        if (entry.status !== "archived" && retired(entry)) remove(team.id);
      }
      await refreshTeams();
    },
    /** Whether old Buzz teams import into config channels here; when not,
     * Import keeps its local team. */
    importsTeams: input.communityId !== undefined,
    /** Imports old Buzz team `id` with `team`'s members into its config
     * channel (§6.3): every device's import of it converges on one team. */
    async importTeam(
      id: string,
      team: Pick<Team, "name" | "instructions" | "members">,
    ) {
      const entry = await publishTeam(
        teamDeps,
        { kind: "old-buzz-team", id },
        team,
      );
      await refreshTeams();
      return entry;
    },
    /** Creates the team the open form `creation` stands for. Saving the
     * same `creation` again finishes that one team, whatever the form now
     * says, never a second. Throws until every member is confirmed added. */
    async createTeam(
      team: Pick<Team, "name" | "instructions" | "members">,
      creation: string,
    ) {
      const entry = await publishTeam(
        teamDeps,
        { kind: "new", id: creation },
        team,
      );
      if (entry.status !== "confirmed")
        throw new Error(
          "error" in entry && entry.error
            ? entry.error
            : "The team couldn't be created",
        );
      await refreshTeams();
      // Its members wait in the journal; Save again or the next connection
      // retries them, on this same team.
      if (!teamComplete(entry))
        throw new Error(
          "The team was created, but some members weren't confirmed; try again.",
        );
      // An earlier attempt published what the form said then.
      const made = teams?.find((t) => t.id === entry.teamId && !t.archived);
      const changed =
        entry.team?.name !== team.name ||
        entry.team.instructions !== team.instructions ||
        entry.intendedMembers.some((p) => !team.members.includes(p));
      if (made && changed) {
        const { saved, failed } = await editTeam(teamDeps, made, team);
        await refreshTeams();
        if ((saved && saved.status !== "saved") || failed.length)
          throw new Error(
            "The team was created, but its latest changes weren't confirmed; try again.",
          );
      }
      return entry.teamId;
    },
    /** Deletes synced team `id` by archiving its config channel. */
    archiveTeam: (id: string) => teamLifecycle(id, "archive"),
    /** Brings an archived team back by unarchiving its config channel. */
    recoverTeam: (id: string) => teamLifecycle(id, "unarchive"),
    async editTeam(
      id: string,
      change: Pick<Team, "name" | "instructions" | "members">,
      base?: string,
    ) {
      const team = teams?.find((t) => t.id === id && !t.archived);
      if (!team) throw new Error("No such team");
      if (team.unreadable)
        throw new Error("This team can't be read right now; try again");
      const result = await editTeam(teamDeps, team, change, base ?? team.head);
      await refreshTeams();
      return result;
    },
    /** Saves each synced side the edit changed as its next revision of
     * `base`, the head its editor opened (the stored head where absent). The
     * local row keeps the edit, so on a conflict it stays as a draft. */
    async save(agent: ConfigAgent, config: object, base: ConfigBase = {}) {
      configs.set(agent.pubkey, { ...agent, config });
      const results: Partial<Record<Side, Saved>> = {};
      const binding = bindings.get(agent.pubkey) ?? {};
      for (const side of SIDES) {
        const local = binding[side];
        if (local?.mode !== "synced" || !edits(side, agent, config)) continue;
        const opened =
          side in base ? base[side] : store.state(local.subject).head;
        const next = content(side, agent, config, opened ?? undefined);
        if (next === opened?.content) continue;
        const type = TYPE[side];
        results[side] = await save(
          deps,
          {
            ...sidesOf.get(agent.pubkey)?.get(side),
            subject: local.subject,
            title: TITLE[side],
            expected: {
              channel: local.subject.channel,
              type,
              d: await artifactD(type, local.subject.channel),
            },
          },
          next,
          undefined,
          opened?.id ?? null,
        );
      }
      return results;
    },
    dispose() {
      disposed = true;
      sync.dispose();
      input.dispose?.();
    },
  };
}

export type CommunityConfig = ReturnType<typeof agentConfigs>;
