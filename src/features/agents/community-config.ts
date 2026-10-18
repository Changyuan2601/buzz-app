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
  importedTeamId,
  teamSubject,
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
  type SyncedTeam,
  type TeamDeps,
  type TeamJournal,
  teamCommunity,
} from "./team-config";
import {
  established,
  type RunnerDeps,
  type TeamIntent,
  type TeamOp,
  type TeamOps,
  teamOpProblem,
  teamRunner,
  unresolved,
} from "./team-ops";

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
  /** Team changes this device has unfinished. */
  ops: TeamOps;
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
  /** Removes a local team's row once its move onto the relay is done. */
  retire(localTeamId: string): void;
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
    ops: input.journals.ops,
    lifecycle: input.journals.lifecycle,
    owner,
    community,
    communityId: readSnapshotCommunity(
      (info as { read_state_snapshot?: unknown } | null)?.read_state_snapshot,
    ),
    strip: input.strip,
    changed: input.changed,
    retire: input.retire,
    dispose: feed.dispose,
  });
  return configs;
}

/** Per-agent config channels over one community's sync and writers. */
export function agentConfigs(
  input: Readonly<{
    channels: TeamDeps["channels"] &
      RunnerDeps["channels"] &
      LifecycleDeps["channels"];
    sync: Pick<ConfigSync, "bind" | "unbind" | "dispose">;
    deps: WriteDeps;
    teamJournal: TeamJournal;
    ops: TeamOps;
    lifecycle: LifecycleJournal;
    owner: string;
    community: string;
    communityId?: string | undefined;
    strip(pubkey: string, side: Side, accepted?: RelayEvent): void;
    changed(): void;
    retire(localTeamId: string): void;
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
    ops: input.ops,
    owner,
    community,
  };
  /** The head each finished change left: a form's Save again after its
   * change finished edits from there. */
  const finishedAt = new Map<string, string>();
  const runner = teamRunner({
    read: deps.read,
    writer: deps.writer,
    maxEventBytes: deps.maxEventBytes,
    signal,
    channels,
    sync,
    store: deps.store,
    ops: input.ops,
    owner,
    community,
    done(op) {
      // A move retires its local row only once its relay team is
      // established, first: if that can't be saved, the record and its
      // handover stay. Unestablished, the record is the row's only link to
      // a relay team that may exist or appear later, so it is never
      // dismissed: the prompt never gets both copies, and the row is never
      // lost. The owner finishes it with Resubmit instead.
      if (op.local && established(op)) input.retire(op.local);
      else if (op.local)
        throw new Error(
          "This move never took over its relay team, so it can't be dismissed. Resubmit it to finish; if the team is archived, recover it first.",
        );
      if (op.confirmedHead) finishedAt.set(op.id, op.confirmedHead);
    },
    changed: () => input.changed(),
  });
  /** Which record each open form submitted (in memory): Save again from
   * that form revises the same change, and no form takes another's. */
  const forms = new Map<string, string>();
  /** Runs `done` to its end for this step, re-reads teams, and throws what
   * stops the change while it is unfinished. */
  async function finished(done: Promise<TeamOp | undefined>) {
    const after = await done;
    await refreshTeams().catch(() => {});
    if (after) throw new Error(teamOpProblem(after));
  }
  /** A submission from form `form`: a newer intent for its change, or a new
   * change. */
  function submitted(
    form: string,
    intent: TeamIntent,
    input: Parameters<typeof runner.start>[0],
    operation?: string,
  ) {
    // A reopened change names its stored record: Save revises exactly that
    // one, even after a restart; a stopped one waits for Resubmit or Dismiss.
    if (operation) {
      forms.set(form, operation);
      if (runner.revise(operation, intent)) return runner.run(operation);
      if (runner.records().some((op) => op.id === operation))
        throw new Error("This change stopped. Resubmit or dismiss it.");
    }
    const prior = forms.get(form);
    if (prior && runner.revise(prior, intent)) return runner.run(prior);
    const { op, done } = runner.start(input);
    forms.set(form, op.id);
    return done;
  }
  const ownTeam = (id: string) => {
    const team = teams?.find((t) => t.id === id);
    if (!team) throw new Error("No such team");
    return team;
  };
  /** Refuses `intent` for team `id` while its Create is unfinished when it
   * drops a member on the team's roster, freshly read for this Save, or one
   * whose add was or may have been sent: a Create removes nobody. Returns
   * that Create. */
  const refuseDroppingJoined = async (id: string, intent: TeamIntent) => {
    const create = () =>
      runner.records().find((op) => op.kind === "create" && op.teamId === id);
    const before = create();
    if (!before) return undefined;
    const unreadable = new Error(
      "This team can't be read right now; try again",
    );
    const found = await channels
      .find("team-config", await teamSubject(id), signal)
      .catch(() => {
        throw unreadable;
      });
    // Its channel was created yet isn't found, or has no roster: no proof.
    if (found ? !found.members : before.channel) throw unreadable;
    const joined: string[] = [];
    for (const pubkey of found?.members ?? [])
      if (
        pubkey !== owner &&
        (await channels.owns(pubkey, signal).catch(() => true))
      )
        joined.push(pubkey);
    // Read after the roster, so an add sent meanwhile still counts.
    const now = create();
    const sent = (now?.commands ?? []).flatMap((c) =>
      c.action === "add" &&
      (c.state === "maybe-sent" || c.state === "confirmed") &&
      c.pubkey
        ? [c.pubkey]
        : [],
    );
    if ([...joined, ...sent].some((p) => !intent.members.includes(p)))
      throw new Error(
        "A member joined or may have joined this new team; remove them after the team is created",
      );
    return now;
  };
  /** Accepts a Save of `intent` for team `id` through `accept`. While its
   * Create is unfinished, the roster check and the acceptance run as one step
   * on the team's queue: no earlier add is still in flight, and no step of
   * the older intent dispatches or replans between them. `accept` must not
   * await the team's steps, which queue behind it. */
  async function accepted<T>(
    id: string,
    intent: TeamIntent,
    accept: (create: TeamOp | undefined) => T,
  ): Promise<T> {
    const unfinished = () =>
      runner.records().some((op) => op.kind === "create" && op.teamId === id);
    if (!unfinished()) return accept(undefined);
    return runner.exclusive(id, async () =>
      accept(await refuseDroppingJoined(id, intent)),
    );
  }
  const importId = (source: "old-buzz-team" | "local-team", sourceId: string) =>
    importedTeamId({
      owner,
      community: input.communityId as string,
      source,
      sourceId,
    });
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

  /** Runs every unfinished team change here, then re-reads teams: when
   * agent channels appear and on each connection. */
  async function resumeTeams() {
    if (disposed || !runner.records().length) return;
    await runner.resume();
    if (!disposed) await refreshTeams().catch(() => {});
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
    /** This scope's unfinished team changes, oldest first. */
    teamOps: () => runner.records(),
    /** Check again: reconciles a change from fresh reads now. */
    async checkTeamOp(id: string) {
      await runner.run(id);
      await refreshTeams().catch(() => {});
    },
    discardTeamOp: (id: string) => runner.discard(id),
    dismissTeamOp: (id: string) => runner.dismiss(id),
    /** Resubmits a stopped change on the team's current head. */
    async resubmitTeamOp(id: string) {
      const op = runner.records().find((record) => record.id === id);
      if (!op) throw new Error("Nothing to resubmit");
      const team = teams?.find((t) => t.id === op.teamId);
      return finished(runner.resubmit(id, team?.head ?? null).done);
    },
    /** Moves each local team whose members are all in this community onto
     * the relay, at its UUIDv5 id. Its row goes once the move is done. */
    async migrateTeams(
      local: readonly Team[],
      communityOf: (pubkey: string) => string | undefined,
      source: (team: Team) => NonNullable<TeamOp["source"]> = (team) => ({
        kind: "local-team",
        id: team.id,
      }),
    ) {
      if (input.communityId === undefined) return;
      for (const team of local) {
        if (teamCommunity(team, communityOf) !== community) continue;
        const prior = runner.records().find((op) => op.local === team.id);
        const from = source(team);
        const intent = {
          name: team.name,
          instructions: team.instructions,
          members: team.members,
        };
        // The row as it stands now: edits made to it meanwhile move too.
        if (prior) runner.revise(prior.id, intent);
        await (prior
          ? runner.run(prior.id)
          : runner.start({
              kind: "move",
              teamId: await importId(from.kind, from.id),
              source: from,
              local: team.id,
              intent,
            }).done
        ).catch(() => {});
      }
      await refreshTeams().catch(() => {});
    },
    /** Whether old Buzz teams import into config channels here; when not,
     * Import keeps its local team. */
    importsTeams: input.communityId !== undefined,
    /** Imports old Buzz team `id` with `team`'s members (§6.3): every
     * device's import of it converges on one team, whose name and
     * instructions an import never replaces. `archived`: only a deleted copy
     * exists. `missing`: members not confirmed on it yet. */
    async importTeam(id: string, team: TeamIntent) {
      const teamId = await importId("old-buzz-team", id);
      const prior = runner
        .records()
        .find((op) => op.kind === "import" && op.teamId === teamId);
      const intent = {
        ...team,
        members: [
          ...new Set([...(prior?.intent.members ?? []), ...team.members]),
        ],
      };
      const done =
        prior && runner.revise(prior.id, intent)
          ? runner.run(prior.id)
          : runner.start({
              kind: "import",
              teamId,
              source: { kind: "old-buzz-team", id },
              intent,
            }).done;
      const after = await done;
      await refreshTeams().catch(() => {});
      // A member add that may have been sent keeps the change, unfinished.
      if (
        after?.stop === "archived" &&
        !after.candidate &&
        !unresolved(after)
      ) {
        runner.dismiss(after.id);
        return { teamId, archived: true as const, missing: [] };
      }
      const confirmed = new Set(
        (after?.commands ?? []).flatMap((c) =>
          c.state === "confirmed" && c.pubkey ? [c.pubkey] : [],
        ),
      );
      return {
        teamId,
        missing: after ? intent.members.filter((p) => !confirmed.has(p)) : [],
        ...(after ? { problem: teamOpProblem(after) } : {}),
      };
    },
    /** Creates the team the open form `form` stands for, at that id: Save
     * again from the same form revises that one change, never a second. */
    async createTeam(team: TeamIntent, form: string, operation?: string) {
      const saved = await accepted(form, team, () => {
        // A reopened change that finished here saves as an edit of its head:
        // this form's latest finished submission, else the reopened one.
        const head =
          finishedAt.get(forms.get(form) ?? "") ??
          finishedAt.get(operation ?? "");
        if (head) return { head };
        return {
          done: submitted(
            form,
            team,
            { kind: "create", teamId: form, intent: team, base: null },
            operation,
          ),
        };
      });
      if ("head" in saved)
        return this.editTeam(form, team, saved.head, form).then(() => form);
      return finished(saved.done).then(() => form);
    },
    /** Deletes synced team `id` by archiving its config channel. */
    archiveTeam(id: string) {
      const team = ownTeam(id);
      return finished(
        runner.start({
          kind: "delete",
          teamId: id,
          channel: team.channel,
          intent: { name: "", instructions: "", members: [] },
        }).done,
      );
    },
    /** Brings an archived team back by unarchiving its config channel. */
    recoverTeam(id: string) {
      const team = ownTeam(id);
      return finished(
        runner.start({
          kind: "recover",
          teamId: id,
          channel: team.channel,
          intent: { name: "", instructions: "", members: [] },
        }).done,
      );
    },
    /** Edits synced team `id` from the head `base` its form opened. */
    async editTeam(
      id: string,
      change: TeamIntent,
      base: string | undefined,
      form: string,
    ) {
      const team = ownTeam(id);
      if (team.archived) throw new Error("No such team");
      const { done } = await accepted(id, change, (create) => {
        if (team.unreadable)
          throw new Error("This team can't be read right now; try again");
        // While its Create is unfinished, the Save revises that Create: a
        // separate Edit would leave its older intent to replay.
        return {
          done: submitted(
            form,
            change,
            {
              kind: "edit",
              teamId: id,
              channel: team.channel,
              intent: change,
              base: base ?? team.head ?? null,
            },
            create?.id,
          ),
        };
      });
      return finished(done);
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
