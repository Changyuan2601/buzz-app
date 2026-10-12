// Agents: agents that are plugins from the start. A plugin registers an agent
// type (its summary line, peek view, settings tabs and `run`); each agent made
// from it has its own native-held key, an `agent-attention/v1` configuration the
// app owns and edits, and a config blob the type owns. The app delivers matching live events to
// `run` from the stream the owner already receives in the agent's community,
// selected or not, so no plugin opens a socket or a REQ.
import { migrateAgentStorage } from "./migrate-storage";
import { Service, type Context } from "@deepseek-ai/cordis";
import { npubEncode } from "nostr-tools/nip19";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { LocalAgentsSnapshot } from "./local";
import { attestedOwner } from "./owner-attestation";
import { removeAgentFromChannels } from "./relay-removal";
import { communityDestination, relayOrigin } from "../communities/destination";
import type { Communities } from "../communities/service";
import type { RelayEvent } from "../relay/events";
import { EFFORT_TAG, MODEL_TAG } from "../relay/messages";
import type { LiveBatch } from "../relay/incoming";
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  addressedTo,
  CHAT_KINDS,
  compileFilter,
  parseSlug,
  tagsAgent,
  watchMatches,
  type AttentionObject,
  type AttentionValue,
  timerSpent,
  timerState,
  type EventWatch,
  type Interest,
  type TimerState,
  type TimerWatch,
} from "./attention";
import {
  nativeAgents,
  type AgentEventTemplate,
  type AgentIdentity,
  type Carry,
  type AgentsNative,
  type AgentUpload,
  type PortableAgents,
  type PortSource,
} from "./native";
import {
  readRecords,
  readTeams,
  setAttention,
  writeRecords,
  writeTeams,
  type AgentRecord,
  type SkippedObject,
  type Team,
} from "./store";
// STOPGAP(agent-local-typing): delete with local-typing.ts.
import { typeLocally } from "./local-typing";
// STOPGAP(agent-working-reactions): delete with working-reactions.ts.
import { reactWhileWorking } from "./working-reactions";

/** One of the viewer's agents, in the community at `relay`. */
export type Agent<Config = unknown> = Readonly<{
  pubkey: string;
  name: string;
  picture?: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  owner: string;
  relay: string;
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored attention objects that are invalid or over a limit, by slug. */
  skipped: Readonly<Record<string, SkippedObject>>;
  /** Run state of its timers, by slug; written only by the runtime. */
  timers: Readonly<Record<string, TimerState>>;
  config: Config;
}>;
export type AgentChange<Config = unknown> = Readonly<{
  name?: string;
  /** An HTTPS image URL; `null` or empty removes the picture. */
  picture?: string | null;
  config?: Config;
  /** Slug to new value; `null` deletes the object. */
  attention?: Readonly<Record<string, AttentionValue | null>>;
}>;
/** What a type's read-only peek receives. */
export type AgentPeekProps<Config = unknown> = { agent: Agent<Config> };
/** What each of a type's settings tabs receives. A type writes only its own
 * config; the app owns the name and attention. */
export type AgentViewProps<Config = unknown> = {
  agent: Agent<Config>;
  /** Replaces the type's whole config. Spread `agent.config` to change one
   * field, or tabs that each save a part will erase each other's fields. */
  save(config: Config): Promise<void>;
};
export type AgentTab<Config = unknown> = Readonly<{
  id: string;
  title: string;
  component: ComponentType<AgentViewProps<Config>>;
}>;
/** The agent as `run` holds it. It works for as long as the agent exists. */
export type AgentHandle = Readonly<{
  pubkey: string;
  name: string;
  owner: string;
  publish(event: AgentEventTemplate): Promise<RelayEvent>;
  /** Reads the community as the agent, seeing only what it may see. */
  query(filters: readonly object[]): Promise<RelayEvent[]>;
  /** Uploads base64 `data`, an image or MP4 video, as the agent. */
  upload(data: string, mime: string): Promise<AgentUpload>;
  /** Writes memory entry `slug`, newer than the entry it replaces (`after`,
   * that entry's `createdAt`, or 0). The owner reads it back. */
  remember(slug: string, body: string, after: number): Promise<RelayEvent>;
}>;
export type Trigger =
  /** Directly addressed: a chat message that mentions the agent or replies to
   * something it wrote. */
  | Readonly<{ type: "mention"; event: RelayEvent }>
  /** One matching watch; an event that matches several runs once for each. */
  | Readonly<{
      type: "watch";
      event: RelayEvent;
      slug: string;
      watch: EventWatch;
      /** Absent when the watch names an Interest that does not exist. */
      interest?: Interest;
      /** Set when the watch has a classifier this app could not run. The spec
       * passes the event rather than lose a match to an unavailable model. */
      classifier?: "not run";
    }>
  | Readonly<{
      type: "timer";
      slug: string;
      timer: TimerWatch;
      /** Absent when the timer names an Interest that does not exist. */
      interest?: Interest;
    }>;
export type Delivery<Config = unknown> = Readonly<{
  trigger: Trigger;
  /** The live route's channel; absent when the wire scope was ambiguous. */
  channelId?: string;
  agent: AgentHandle;
  /** The agent's config when this run started. */
  config: Config;
  /** The model the owner asked for in the triggering message: one of the
   * type's `models`. Absent means the agent's own model. */
  model?: string;
  /** The effort level the owner asked for in the triggering message: one of
   * that model's `efforts`. Absent means the agent's own default. */
  effort?: string;
  /** A section for each team the agent is on, with the team's name, roster and
   * instructions, to follow the agent's own instructions. Absent without one. */
  team?: string;
  /** Aborts on the run's deadline, or when the agent is removed or its type is
   * replaced. Advisory: the handle keeps working, so finishing up is harmless. */
  signal: AbortSignal;
  /** Keeps the run counted as working after `run` returns, until `done`
   * settles, for a type that hands its work off and returns early. */
  workingUntil(done: PromiseLike<unknown>): void;
}>;
export type Effort = Readonly<{ id: string; label: string }>;
/** A model with its effort levels, lowest first. */
export type Model = Readonly<{
  id: string;
  label: string;
  efforts: readonly Effort[];
  /** The effort a run on it uses without a pick, when known. */
  effort?: string;
}>;
/** The models an owner can pick from, and the id of the one used without a pick. */
export type Models = Readonly<{ current: string; models: readonly Model[] }>;
export type AgentType<Config = unknown> = {
  id: string;
  title: string;
  description?: string;
  /** A new agent's starting config and attention objects. */
  defaults(): Readonly<{
    config: Config;
    attention?: Readonly<Record<string, AttentionValue>>;
  }>;
  /** A brought-over agent's config: `config` from `defaults` with whatever of
   * `carry` the type has a place for. Without it, all of `carry` stays behind. */
  adopt?(carry: Carry, config: Config): Config;
  /** One short line under the agent's name, e.g. its model; defaults to the title. */
  summary?(agent: Agent<Config>): string;
  /** A read-only glance shown when the agent is selected in the grid. */
  Peek?: ComponentType<AgentPeekProps<Config>>;
  /** The type's settings tabs, in order. The host adds Attention after them. */
  tabs?: readonly AgentTab<Config>[];
  /** Models and effort levels the owner can pick for the next run while
   * mentioning the agent. Discovery may be async but must not start a turn.
   * The picks reach that run as `Delivery.model` and `Delivery.effort`. */
  models?(agent: Agent<Config>): Models | Promise<Models>;
  run?(delivery: Delivery<Config>): void | Promise<void>;
  /** Per-run deadline in milliseconds, up to 30 minutes; defaults to 60 seconds. */
  timeoutMs?: number;
};
export type RegisteredAgentType = Contribution<AgentType>;
export type AgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
  /** The selected community's agents, while it is connected. */
  agents: readonly Agent[];
  /** Every agent kept running here, whichever community is selected: the
   * viewer's agents in each joined community not disconnected. */
  running: readonly Agent[];
  /** The owner's teams on this device, in any community. */
  teams: readonly Team[];
  error?: string;
}>;
export type { Carry, Team };
export type TeamChange = Omit<Team, "id"> & Readonly<{ id?: string }>;
export type Agents = {
  register<Config>(type: AgentType<Config>): void;
  types(): readonly RegisteredAgentType[];
  snapshot(): AgentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** The agent of this pubkey in the selected community, if it is an agent. */
  find(pubkey: string): Agent | undefined;
  /** The owner's connection to a running agent's community, which need not be
   * the selected one: read the agent's conversations through this. */
  relay(pubkey: string): RelayData | undefined;
  create(input: Readonly<{ type: string; name: string }>): Promise<Agent>;
  /** Identities earlier agent systems saved on this machine that are not
   * Agents yet. */
  portable(): Promise<PortableAgents>;
  /** Takes one over as an agent of `type` in the selected community, keeping its
   * key, name and picture, and whatever of its instructions and workspace the
   * type adopts. Its other settings stay behind. */
  port(
    input: Readonly<{ source: PortSource; pubkey: string; type: string }>,
  ): Promise<Agent>;
  save(pubkey: string, change: AgentChange): Promise<void>;
  /** Deletes its key at once. Leaving its channels and archiving it follow in
   * the background whenever its community is open. */
  remove(pubkey: string): Promise<void>;
  /** Creates a team, or replaces the one with `id`. Members must be agents on
   * this device. */
  saveTeam(team: TeamChange): Promise<Team>;
  /** Deletes the team; its agents are untouched. */
  removeTeam(id: string): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    agents: Agents;
  }
}

const QUEUE_LIMIT = 32;
/** The spec asks for at least the agent's 2,048 most recent events. */
const SEEN_LIMIT = 2_048;
/** Bounds one cleanup attempt, whose relay steps otherwise wait on the outbox. */
const CLEANUP_TIMEOUT_MS = 60_000;
/** Runs per agent per minute; bounds two agents that answer each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const TIMEOUT_LIMIT_MS = 30 * 60_000;
const TIMER_TICK_MS = 5_000;
/** How often a failed connection to an unselected community is tried again. */
const RETRY_MS = 30_000;
const EMPTY = Object.freeze({});
const blank = (pubkey: string): AgentRecord => ({
  pubkey,
  attention: EMPTY,
  config: undefined,
});
/** A new agent's settings: its type's defaults. */
function defaults(pubkey: string, type: RegisteredAgentType) {
  const { config, attention = {} } = type.defaults();
  let record: AgentRecord = { pubkey, attention: {}, config };
  for (const [slug, value] of Object.entries(attention))
    record = setAttention(record, slug, value);
  return record;
}
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);
/** The team sections for agent `self`: each team it is on, its members that
 * still exist by name and npub, and the team's instructions. */
export function teamPrompt(
  teams: readonly Team[],
  agents: readonly Pick<AgentIdentity, "pubkey" | "name">[],
  self: string,
) {
  const names = new Map(agents.map((agent) => [agent.pubkey, agent.name]));
  return teams
    .filter((team) => team.members.includes(self))
    .map((team) => {
      const roster = team.members.flatMap((pubkey) => {
        const name = names.get(pubkey);
        return name === undefined
          ? []
          : [
              `- ${name} (${npubEncode(pubkey)})${pubkey === self ? ", you" : ""}`,
            ];
      });
      return [
        "<team>",
        `You are on the team ${JSON.stringify(team.name)}. Its members, you included:`,
        ...roster,
        "Mention a teammate by name, with their npub, to reach them.",
        ...(team.instructions.trim()
          ? [
              "<team-instructions>",
              team.instructions.trim(),
              "</team-instructions>",
            ]
          : []),
        "</team>",
      ].join("\n");
    })
    .join("\n\n");
}
const bounded = (set: Set<string>, id: string) => {
  set.add(id);
  if (set.size > SEEN_LIMIT) set.delete(set.values().next().value as string);
};
/** Whether an agent answers `event`: its owner's, or one by another agent the
 * owner attested (NIP-OA). Both bundled types answer nobody else. */
export async function fromOwner(
  event: Pick<RelayEvent, "pubkey" | "kind" | "created_at" | "tags">,
  owner: string,
) {
  return event.pubkey === owner || (await attestedOwner(event)) === owner;
}

/** The model and effort the triggering message asks of this agent. Only the
 * owner picks them, so nobody else in a channel can run the agent at their
 * level, and only ones the type lists: effort from the model the run uses. */
async function pickFor(
  trigger: Trigger,
  agent: Agent,
  type: RegisteredAgentType,
): Promise<{ model?: string; effort?: string }> {
  if (trigger.type === "timer" || trigger.event.pubkey !== agent.owner)
    return {};
  const asked = (name: string) =>
    trigger.event.tags.find(
      (tag) => tag[0] === name && tag[1] === agent.pubkey,
    )?.[2];
  const model = asked(MODEL_TAG);
  const effort = asked(EFFORT_TAG);
  if (!model && !effort) return {};
  try {
    const offered = await type.models?.(agent);
    const picked = offered?.models.find((item) => item.id === model);
    const runs =
      picked ?? offered?.models.find((item) => item.id === offered.current);
    return {
      ...(picked ? { model: picked.id } : {}),
      ...(effort && runs?.efforts.some((level) => level.id === effort)
        ? { effort }
        : {}),
    };
  } catch (error) {
    console.warn(`Agent type ${type.key} could not list its models`, error);
    return {};
  }
}

/** What Agents needs of the communities: the viewer, the selected one, and
 * a connection to any joined one without selecting it. */
export type AgentCommunities = Pick<
  Communities,
  "snapshot" | "subscribe" | "open"
>;
type Binding = {
  scope: string;
  origin: string;
  viewer: string;
  session: RelaySession;
  /** Aborts when this binding is replaced, so no work outlives its session. */
  controller: AbortController;
  stopLive: () => void;
};
/** A community the viewer has an agent in, and its session while live. */
type Bound = {
  relay: RelayData;
  stop: () => void;
  binding?: Binding | undefined;
  /** When its failed connection was last tried again. */
  retried?: number;
};
/** The origin a relay URL or community ID names, if it is a valid one. */
const originOf = (value: string) => {
  try {
    return communityDestination(value).url;
  } catch {
    return undefined;
  }
};
type Job = { trigger: Trigger; channelId?: string };
type WatchTrigger = Extract<Trigger, { type: "watch" }>;
type CompiledWatch = Omit<WatchTrigger, "type" | "event"> & {
  filter?: ReturnType<typeof compileFilter>;
};
/** One agent's runtime, for as long as its identity exists. Edits do not
 * replace it: each job reads the agent as it is when the job starts, and the
 * watches are recompiled only when its attention changes. */
type Runner = {
  readonly pubkey: string;
  /** The registration whose `run` it calls; a new one aborts the in-flight run. */
  type: RegisteredAgentType | undefined;
  controller: AbortController;
  /** Events waiting to run; due timers are found when a run starts instead. */
  queue: Job[];
  running: boolean;
  windowStart: number;
  admitted: number;
  /** Events seen, and events it wrote (so replies to it are addressed). */
  readonly seen: Set<string>;
  readonly wrote: Set<string>;
  /** Whether native may hold the agent for this copy; true at first, since
   * native outlives a page reload. */
  mayHold: boolean;
  compiled?: {
    attention: Agent["attention"];
    watches: readonly CompiledWatch[];
  };
};

export class AgentsService extends Service implements Agents {
  private readonly contributions;
  private readonly listeners = new Set<() => void>();
  /** Every saved identity, deleted ones included: native's list is the agent
   * list, and `records` only adds settings to it. */
  private identities: readonly AgentIdentity[] = [];
  private records: Record<string, AgentRecord>;
  private teamList: readonly Team[];
  private state: AgentsSnapshot;
  /** By origin, so each agent listens in its own community, selected or not. */
  private bound = new Map<string, Bound>();
  /** Agents whose community was live at the last update. */
  private connected = new Set<string>();
  private runners = new Map<string, Runner>();
  /** Counts list requests, so only the latest one is applied. */
  private listed = 0;
  /** Deleted agents whose community cleanup is running, and whether it was
   * asked for again meanwhile, as when the connection recovers mid-attempt. */
  private cleaning = new Map<string, boolean>();

  constructor(
    ctx: Context,
    private readonly communities: AgentCommunities,
    private readonly native: AgentsNative | undefined = nativeAgents(),
    private readonly storage: Storage = globalThis.localStorage,
  ) {
    super(ctx, "agents");
    this.contributions = createContributions<AgentType>(ctx);
    migrateAgentStorage(storage);
    this.records = readRecords(storage);
    this.teamList = Object.freeze(readTeams(storage));
    this.state = Object.freeze({
      status: native ? "loading" : "unavailable",
      agents: [],
      running: [],
      teams: this.teamList,
    });
    ctx.effect(() => {
      const stops = [
        this.contributions.subscribe(() => {
          this.update();
          this.notify();
        }),
        communities.subscribe(() => {
          this.watch();
          this.update();
        }),
      ];
      this.watch();
      void this.refresh();
      // Wakes each runner, which starts any timer that is due.
      const tick = setInterval(() => {
        for (const runner of this.runners.values()) void this.drain(runner);
        this.reconnect();
      }, TIMER_TICK_MS);
      return () => {
        clearInterval(tick);
        // A list still being read is stale: it must not reopen communities.
        this.listed++;
        for (const stop of stops) stop();
        for (const origin of [...this.bound.keys()]) this.unbind(origin);
        for (const runner of this.runners.values()) this.retire(runner);
        this.runners.clear();
        // Clear what is shown without reconciling, which would make new runners.
        this.state = Object.freeze({
          ...this.state,
          agents: Object.freeze([]),
          running: Object.freeze([]),
        });
        this.notify();
      };
    });
  }

  register<Config>(type: AgentType<Config>) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(type.id ?? "") ||
      !type.title ||
      typeof type.defaults !== "function"
    )
      throw new Error("Agent types need an id, a title and defaults");
    if (
      type.timeoutMs !== undefined &&
      !(
        Number.isInteger(type.timeoutMs) &&
        type.timeoutMs >= 1 &&
        type.timeoutMs <= TIMEOUT_LIMIT_MS
      )
    )
      throw new Error(
        `Agent type timeoutMs must be a whole number from 1 to ${TIMEOUT_LIMIT_MS}`,
      );
    this.contributions.register(this.ctx, type as unknown as AgentType);
  }
  types = () => this.contributions.snapshot();
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  find = (pubkey: string) =>
    this.state.agents.find((agent) => agent.pubkey === pubkey);
  relay = (pubkey: string) => {
    const origin = originOf(this.agent(pubkey)?.relay ?? "");
    return origin ? this.bound.get(origin)?.relay : undefined;
  };
  private localCache:
    | {
        identities: readonly AgentIdentity[];
        state: Pick<AgentsSnapshot, "status" | "error">;
        value: LocalAgentsSnapshot;
      }
    | undefined;
  /** Every live agent, in any community, for names and mentions. `snapshot`
   * holds only the selected community's, with their settings. */
  local = (): LocalAgentsSnapshot => {
    const { identities, state } = this;
    const cached = this.localCache;
    if (
      cached?.identities === identities &&
      cached.state.status === state.status &&
      cached.state.error === state.error
    )
      return cached.value;
    const value: LocalAgentsSnapshot = Object.freeze({
      status: state.status,
      agents: Object.freeze(
        identities
          .filter((identity) => !identity.deleted)
          .map(({ pubkey, name, relay, owner }) =>
            Object.freeze({ pubkey, name, relayUrl: relay, owner }),
          ),
      ),
      ...(state.error ? { error: state.error } : {}),
    });
    this.localCache = { identities, state, value };
    return value;
  };

  async create({ type, name }: Readonly<{ type: string; name: string }>) {
    if (!name.trim()) throw new Error("Name the agent");
    return this.add(type, async (native, destination, owner) => ({
      agent: await native.create(destination, owner, type, name.trim()),
    }));
  }

  async portable() {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const found = await native.portable();
    const own = new Set(
      this.identities
        .filter((identity) => !identity.deleted)
        .map((identity) => identity.pubkey),
    );
    return {
      ...found,
      agents: found.agents.filter((agent) => !own.has(agent.pubkey)),
    };
  }

  async port({
    source,
    pubkey,
    type,
  }: Readonly<{ source: PortSource; pubkey: string; type: string }>) {
    return this.add(type, (native, destination, owner) =>
      native.port(source, pubkey, destination, owner, type),
    );
  }

  /** Saves a new identity of `type` in the selected community with the type's
   * default settings, adopting what a brought-over one carried. */
  private async add(
    type: string,
    save: (
      native: AgentsNative,
      destination: string,
      owner: string,
    ) => Promise<Readonly<{ agent: AgentIdentity; carry?: Carry }>>,
  ) {
    const native = this.native;
    const selected = this.communities.snapshot().selected;
    const binding = selected
      ? this.bound.get(originOf(selected) ?? "")?.binding
      : undefined;
    const kind = this.types().find((entry) => entry.key === type);
    if (!native) throw new Error("Agents run only in the desktop app");
    if (!binding) throw new Error("Connect to a community first");
    if (!kind) throw new Error("That agent type is not available");
    const settings = defaults("", kind);
    const { agent: identity, carry } = await save(
      native,
      relayOrigin(binding.origin),
      binding.viewer,
    );
    let record = { ...settings, pubkey: identity.pubkey };
    try {
      if (carry && kind.adopt)
        record = { ...record, config: kind.adopt(carry, record.config) };
      this.write(record);
    } catch (error) {
      // The agent exists either way; unsaved settings start from the defaults.
      console.warn(`Agent ${identity.name} settings were not saved`, error);
    }
    await this.refresh();
    return this.view(identity, record);
  }

  async save(pubkey: string, change: AgentChange) {
    const identity = this.live(pubkey);
    if (!this.native || !identity)
      throw new Error("No such agent on this device");
    const name = change.name?.trim();
    if (name === "") throw new Error("Name the agent");
    let record = this.recordOf(identity);
    if (change.config !== undefined)
      record = { ...record, config: change.config };
    for (const [slug, value] of Object.entries(change.attention ?? {}))
      record = setAttention(record, slug, value);
    // As the spec's writer: an Interest stays while anything still uses it.
    for (const [slug, value] of Object.entries(change.attention ?? {})) {
      const id = parseSlug(slug)?.id;
      if (value !== null || !slug.startsWith("interest/") || !id) continue;
      if (
        Object.values(record.attention).some(
          (object) =>
            object.value.type !== "interest" && object.value.interest_id === id,
        )
      )
        throw new Error(
          "Remove or move the watches and timers that use this Interest first",
        );
    }
    if (change.config !== undefined || change.attention) this.write(record);
    const picture =
      change.picture === undefined ? undefined : change.picture || null;
    const renamed = name !== undefined && name !== identity.name;
    const repictured =
      picture !== undefined && picture !== (identity.picture ?? null);
    if (renamed) await this.native.rename(pubkey, name);
    if (repictured) await this.native.setPicture(pubkey, picture);
    // Shows the new name or picture and publishes it as the agent's profile.
    if (renamed || repictured) await this.refresh();
  }

  async remove(pubkey: string) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    await this.native.remove(pubkey);
    // Drops its settings, and starts its cleanup if its community is connected.
    await this.refresh();
  }

  async saveTeam({ id, name, instructions, members }: TeamChange) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    if (!name.trim()) throw new Error("Name the team");
    const unknown = members.find((pubkey) => !this.live(pubkey));
    if (unknown) throw new Error("A member is not an agent on this device");
    if (id && !this.teamList.some((team) => team.id === id))
      throw new Error("No such team");
    const team: Team = Object.freeze({
      id: id ?? crypto.randomUUID(),
      name: name.trim(),
      instructions,
      members: Object.freeze([...new Set(members)]),
    });
    this.writeTeams(
      id
        ? this.teamList.map((saved) => (saved.id === id ? team : saved))
        : [...this.teamList, team],
    );
    return team;
  }

  async removeTeam(id: string) {
    this.writeTeams(this.teamList.filter((team) => team.id !== id));
  }

  /** Saves the teams; memory changes only once storage has taken them. */
  private writeTeams(teams: readonly Team[]) {
    writeTeams(this.storage, teams);
    this.teamList = Object.freeze(teams);
    this.state = Object.freeze({ ...this.state, teams: this.teamList });
    this.notify();
  }

  /** Saves one record; memory changes only once storage has taken it. */
  private write(record: AgentRecord) {
    const records = { ...this.records, [record.pubkey]: record };
    writeRecords(this.storage, records);
    this.records = records;
    this.update();
  }
  private live(pubkey: string) {
    return this.identities.find(
      (identity) => identity.pubkey === pubkey && !identity.deleted,
    );
  }
  /** Its saved settings or, without any, its type's defaults, kept in memory
   * until a save stores them. Without its type there are no defaults yet. */
  private recordOf({ pubkey, type }: AgentIdentity) {
    const kind = this.types().find((entry) => entry.key === type);
    if (!this.records[pubkey] && kind)
      try {
        this.records = { ...this.records, [pubkey]: defaults(pubkey, kind) };
      } catch (error) {
        console.warn(`Agent type ${type} has invalid defaults`, error);
      }
    return this.records[pubkey] ?? blank(pubkey);
  }
  private view(identity: AgentIdentity, record: AgentRecord): Agent {
    return Object.freeze({
      pubkey: identity.pubkey,
      name: identity.name,
      ...(identity.picture && { picture: identity.picture }),
      type: identity.type,
      owner: identity.owner,
      relay: identity.relay,
      attention: record.attention,
      skipped: record.skipped ?? EMPTY,
      timers: record.timers ?? EMPTY,
      config: record.config,
    });
  }
  /** The live binding of the agent's community, if it has one now. */
  private bindingOf({ relay, owner }: Pick<AgentIdentity, "relay" | "owner">) {
    const origin = originOf(relay);
    const binding = origin ? this.bound.get(origin)?.binding : undefined;
    return binding?.scope === relayPartition(origin ?? "", owner)
      ? binding
      : undefined;
  }
  /** Whether the agent stays running: it is the viewer's, and its community is
   * joined and not disconnected. A reconnect does not stop it. */
  private alive({ relay, owner }: AgentIdentity) {
    const origin = originOf(relay);
    const entry = origin ? this.bound.get(origin) : undefined;
    return (
      owner === this.communities.snapshot().viewer &&
      !!entry &&
      entry.relay.snapshot().status !== "disconnected"
    );
  }
  /** A running agent, in any community. */
  private agent(pubkey: string) {
    return this.state.running.find((agent) => agent.pubkey === pubkey);
  }
  /** The agent, while its community's session is live to run it in. */
  private ready(pubkey: string) {
    const agent = this.agent(pubkey);
    return agent && this.bindingOf(agent) ? agent : undefined;
  }

  /** Reads the agent list from native. Every change is made there first and
   * then read back here, so the list has one source. */
  private async refresh() {
    if (!this.native) return;
    const turn = ++this.listed;
    try {
      const identities = await this.native.list();
      // A newer list is on its way; this one may predate a change.
      if (turn !== this.listed) return;
      this.identities = identities;
      this.state = Object.freeze({ ...this.state, status: "ready" });
      // Settings whose agent is gone do nothing.
      const live = new Set(
        identities
          .filter((saved) => !saved.deleted)
          .map((saved) => saved.pubkey),
      );
      if (Object.keys(this.records).some((pubkey) => !live.has(pubkey))) {
        this.records = Object.fromEntries(
          Object.entries(this.records).filter(([pubkey]) => live.has(pubkey)),
        );
        writeRecords(this.storage, this.records);
      }
      // A deleted agent leaves its teams; the teams stay.
      if (
        this.teamList.some((team) =>
          team.members.some((pubkey) => !live.has(pubkey)),
        )
      )
        this.writeTeams(
          this.teamList.map((team) => ({
            ...team,
            members: team.members.filter((pubkey) => live.has(pubkey)),
          })),
        );
    } catch (error) {
      if (turn !== this.listed) return;
      this.state = Object.freeze({
        ...this.state,
        status: "error",
        error: message(error),
      });
    }
    this.watch();
    this.update();
    this.notify();
    this.sync();
  }

  /** Brings the relay in line with the saved identities: publishes each name
   * its community lacks, and finishes Delete where connected. Each step
   * is safe to repeat; what fails is tried again on the next refresh or connect. */
  private sync() {
    const native = this.native;
    for (const identity of this.identities)
      if (!identity.deleted)
        native
          ?.publishProfile(identity.pubkey)
          .catch((error) =>
            console.warn(
              `Agent ${identity.name} profile was not published`,
              error,
            ),
          );
      else {
        const binding = this.bindingOf(identity);
        if (binding) void this.cleanup(identity.pubkey, binding);
      }
  }
  /** As harness Delete does: leave every channel, then archive the identity so
   * it drops out of member lists and mention suggestions. The owner signs both,
   * so neither needs the deleted key. Nothing is final until each is confirmed. */
  private async cleanup(pubkey: string, binding: Binding) {
    if (this.cleaning.has(pubkey)) {
      this.cleaning.set(pubkey, true);
      return;
    }
    this.cleaning.set(pubkey, false);
    let failed = false;
    const signal = AbortSignal.any([
      binding.controller.signal,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    ]);
    const { session } = binding;
    try {
      await removeAgentFromChannels(session, pubkey, signal);
      const { archives } = session;
      if (archives.writable) {
        // The archive cache is not live; this needs a read started now.
        await archives.ensure();
        await archives.refresh();
        signal.throwIfAborted();
        const state = archives.state(pubkey);
        // An unfinished read says nothing, least of all "not archived".
        if (state === "unknown") throw new Error("Archive state is unknown");
        // Without an owner-attested profile the agent is not in the directory,
        // so there is nothing to hide (and no consent path to archive it with).
        const consent =
          state === "not-archived" && (await archives.consent(pubkey, signal));
        signal.throwIfAborted();
        if (consent) await archives.request("archive", pubkey, signal);
      }
      await this.native?.forget(pubkey);
      await this.refresh();
    } catch (error) {
      failed = !binding.controller.signal.aborted;
      if (failed) console.warn("Deleted agent cleanup will be retried", error);
    } finally {
      const again = this.cleaning.get(pubkey);
      this.cleaning.delete(pubkey);
      if (failed && again) void this.cleanup(pubkey, binding);
    }
  }

  /** Connects the selected community, where agents are made, and each one
   * the viewer has an agent in, deleted ones included so their cleanup can
   * finish; lets go of the rest. */
  private watch() {
    const { viewer, selected } = this.communities.snapshot();
    const origins = new Set<string>();
    const shown = viewer && originOf(selected ?? "");
    if (shown) origins.add(shown);
    for (const identity of this.identities) {
      const origin = identity.owner === viewer && originOf(identity.relay);
      if (origin) origins.add(origin);
    }
    // Left, or left and joined again with a new session.
    for (const [origin, entry] of this.bound)
      if (!origins.has(origin) || this.communities.open(origin) !== entry.relay)
        this.unbind(origin);
    for (const origin of origins) {
      if (this.bound.has(origin)) continue;
      const relay = this.communities.open(origin);
      if (!relay) continue;
      this.bound.set(origin, {
        relay,
        stop: relay.subscribe(() => this.bind(origin)),
      });
      this.bind(origin);
    }
  }
  /** Tries each unselected community whose connection failed again, since
   * nobody is there to press its Retry; its agents wait on it. */
  private reconnect() {
    const selected = originOf(this.communities.snapshot().selected ?? "");
    const now = Date.now();
    for (const [origin, entry] of this.bound)
      if (
        origin !== selected &&
        entry.relay.snapshot().status === "error" &&
        now - (entry.retried ?? 0) >= RETRY_MS
      ) {
        entry.retried = now;
        entry.relay.retry();
      }
  }
  private unbind(origin: string) {
    const entry = this.bound.get(origin);
    this.bound.delete(origin);
    entry?.stop();
    entry?.binding?.stopLive();
    entry?.binding?.controller.abort();
  }
  private bind(origin: string) {
    const entry = this.bound.get(origin);
    if (!entry) return;
    const snapshot = entry.relay.snapshot();
    const live =
      snapshot.status === "ready" &&
      !snapshot.cached &&
      snapshot.scope &&
      snapshot.origin &&
      snapshot.viewer
        ? {
            scope: snapshot.scope,
            origin: snapshot.origin,
            viewer: snapshot.viewer,
            session: snapshot.session,
            controller: new AbortController(),
          }
        : undefined;
    const changed =
      entry.binding?.session !== live?.session ||
      entry.binding?.scope !== live?.scope;
    if (changed) {
      entry.binding?.stopLive();
      entry.binding?.controller.abort();
      entry.binding = live && {
        ...live,
        stopLive: this.listen(live.session, origin),
      };
    }
    // Disconnecting stops its agents even when no binding changed.
    this.update();
    if (changed && live) this.sync();
  }

  /** Delivers the session's live events, and retries what failed whenever its
   * connection recovers, which happens within the same session. */
  private listen(session: RelaySession, origin: string) {
    let connected = session.live.snapshot().status === "connected";
    const stopEvents = session.subscribeLive((batch) =>
      this.dispatch(batch, origin),
    );
    const stopStatus = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now && !connected) this.sync();
      connected = now;
    });
    return () => {
      stopEvents();
      stopStatus();
    };
  }

  // Joins identities, records and the connections into the running and visible
  // agents, and keeps one runner per saved agent. Runners outlive edits and
  // reconnects; one is retired only when its agent is deleted, and its run is
  // aborted when the agent's type is replaced.
  private update() {
    const identities = this.identities.filter((identity) => !identity.deleted);
    const running: Agent[] = [];
    for (const identity of identities) {
      if (!this.alive(identity)) continue;
      const record = this.recordOf(identity);
      // Reuse the frozen agent while nothing visible changed, so subscribers see
      // a stable snapshot.
      const prior = this.agent(identity.pubkey);
      running.push(
        prior &&
          prior.name === identity.name &&
          prior.picture === identity.picture &&
          prior.attention === record.attention &&
          prior.skipped === (record.skipped ?? EMPTY) &&
          prior.timers === (record.timers ?? EMPTY) &&
          prior.config === record.config
          ? prior
          : this.view(identity, record),
      );
    }
    const selected = originOf(this.communities.snapshot().selected ?? "");
    const agents = running.filter(
      (agent) => originOf(agent.relay) === selected && this.bindingOf(agent),
    );
    const types = new Map(this.types().map((type) => [type.key, type]));
    for (const [pubkey, runner] of this.runners)
      if (!identities.some((identity) => identity.pubkey === pubkey)) {
        this.retire(runner);
        this.runners.delete(pubkey);
      }
    for (const identity of identities) {
      const type = types.get(identity.type);
      const runner = this.runners.get(identity.pubkey);
      if (!runner)
        this.runners.set(identity.pubkey, this.runner(identity, type));
      else if (runner.type !== type) {
        runner.controller.abort();
        runner.controller = new AbortController();
        runner.type = type;
        void this.drain(runner);
      }
    }
    const same = (next: readonly Agent[], prior: readonly Agent[]) =>
      next.length === prior.length &&
      next.every((agent, index) => agent === prior[index]);
    if (
      !same(agents, this.state.agents) ||
      !same(running, this.state.running)
    ) {
      this.state = Object.freeze({
        ...this.state,
        agents: Object.freeze(agents),
        running: Object.freeze(running),
      });
      this.notify();
    }
    // Resume runners whose queue paused while their community was not live,
    // and claim or release each agent as its community goes live or not, so a
    // copy of the app takes over without waiting for an event or tick.
    const ready = new Set(
      running.filter((agent) => this.bindingOf(agent)).map((a) => a.pubkey),
    );
    for (const runner of this.runners.values())
      if (
        runner.queue.length ||
        ready.has(runner.pubkey) !== this.connected.has(runner.pubkey)
      )
        void this.drain(runner);
    this.connected = ready;
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }

  private runner(
    identity: AgentIdentity,
    type: RegisteredAgentType | undefined,
  ): Runner {
    return {
      pubkey: identity.pubkey,
      type,
      controller: new AbortController(),
      queue: [],
      running: false,
      windowStart: 0,
      admitted: 0,
      seen: new Set(),
      wrote: new Set(),
      mayHold: true,
    };
  }
  private retire(runner: Runner) {
    runner.queue.length = 0;
    runner.controller.abort();
  }
  /** The runner's event watches for the agent's current attention. */
  private watches(runner: Runner, agent: Agent) {
    if (runner.compiled?.attention === agent.attention)
      return runner.compiled.watches;
    const watches: CompiledWatch[] = [];
    for (const object of Object.values(agent.attention)) {
      const watch = object.value;
      if (watch.type !== "event" || !watch.enabled) continue;
      const interest = agent.attention[`interest/${watch.interest_id}`]?.value;
      watches.push({
        slug: object.slug,
        watch,
        ...(interest?.type === "interest" ? { interest } : {}),
        // No classifier model runs here yet, so the event passes unclassified.
        ...(watch.classifier ? { classifier: "not run" as const } : {}),
        ...(watch.filter ? { filter: compileFilter(watch.filter) } : {}),
      });
    }
    runner.compiled = { attention: agent.attention, watches };
    return watches;
  }

  /** Gives a community's live events to the agents in it. */
  private dispatch(batch: LiveBatch, origin: string) {
    for (const runner of this.runners.values()) {
      const agent = this.ready(runner.pubkey);
      if (!agent || originOf(agent.relay) !== origin || !runner.type?.run)
        continue;
      for (const event of batch.events) {
        if (runner.seen.has(event.id)) continue;
        bounded(runner.seen, event.id);
        // An agent never hears itself; its own events make replies addressed.
        if (event.pubkey === agent.pubkey) {
          bounded(runner.wrote, event.id);
          continue;
        }
        for (const trigger of this.heard(runner, agent, event))
          this.enqueue(runner, {
            trigger,
            ...(batch.channelId ? { channelId: batch.channelId } : {}),
          });
      }
    }
  }
  private heard(runner: Runner, agent: Agent, event: RelayEvent): Trigger[] {
    const wrote = (id: string) => runner.wrote.has(id);
    // Another of the owner's agents wakes it only by naming it, wherever: were a
    // reply to it enough, two agents replying to each other would never stop. The
    // claimed owner only narrows this; the type verifies it before answering.
    if (event.tags.some((tag) => tag[0] === "auth" && tag[1] === agent.owner))
      return CHAT_KINDS.includes(event.kind) && tagsAgent(event, agent.pubkey)
        ? [{ type: "mention", event }]
        : [];
    // Addressed events never reach a watch. Only conversation starts a run: not a
    // DM it cannot read yet, nor a reaction to its message.
    if (addressedTo(event, agent.pubkey, wrote))
      return CHAT_KINDS.includes(event.kind)
        ? [{ type: "mention", event }]
        : [];
    return this.watches(runner, agent)
      .filter(({ watch, filter }) => watchMatches(watch, event, filter))
      .map(({ filter: _, ...match }) => ({ type: "watch", event, ...match }));
  }

  // Spec schedule rules: occurrence k is due at armed_at + k × interval, at most one
  // runs when overdue, then the next is due interval after it ran. A timer with no
  // saved state counts what was already due as used (see timerState). Checked as a
  // run starts, so no timer has more than one occurrence waiting, and one removed,
  // disabled or expired meanwhile never runs. The longest-waiting timer runs first,
  // so one whose runs outlast its interval cannot hold back the others.
  private dueTimer(agent: Agent): Job | undefined {
    const now = Math.floor(Date.now() / 1000);
    const record = this.records[agent.pubkey] ?? blank(agent.pubkey);
    const prior = record.timers ?? EMPTY;
    let timers = prior;
    let next:
      | { slug: string; timer: TimerWatch; state: TimerState }
      | undefined;
    for (const object of Object.values(agent.attention)) {
      const timer = object.value;
      if (timer.type !== "timer" || !timer.enabled) continue;
      const saved = agent.timers[object.slug];
      const state = timerState(timer, saved, now);
      if (state !== saved) timers = { ...timers, [object.slug]: state };
      if (now < state.nextDue || timerSpent(timer, state, now)) continue;
      if (!next || state.nextDue < next.state.nextDue)
        next = { slug: object.slug, timer, state };
    }
    if (next)
      timers = {
        ...timers,
        [next.slug]: {
          ...next.state,
          used: next.state.used + 1,
          nextDue: now + next.timer.interval_secs,
        },
      };
    if (timers !== prior)
      try {
        this.write({ ...record, timers });
      } catch (error) {
        // Unsaved, it would run again at once; it waits for storage instead.
        console.warn(`Agent ${agent.name} timer state was not saved`, error);
        return undefined;
      }
    if (!next) return undefined;
    const { slug, timer } = next;
    const interest = agent.attention[`interest/${timer.interest_id}`]?.value;
    return {
      trigger: {
        type: "timer",
        slug,
        timer,
        ...(interest?.type === "interest" ? { interest } : {}),
      },
    };
  }

  private enqueue(runner: Runner, job: Job) {
    const now = Date.now();
    if (now - runner.windowStart >= RATE_WINDOW_MS) {
      runner.windowStart = now;
      runner.admitted = 0;
    }
    if (runner.queue.length >= QUEUE_LIMIT || runner.admitted >= RATE_LIMIT) {
      console.warn(`Agent ${this.agent(runner.pubkey)?.name} dropped an event`);
      return;
    }
    runner.admitted++;
    runner.queue.push(job);
    void this.drain(runner);
  }

  // One run at a time per agent: events in arrival order, then a due timer.
  // Each job runs the agent as it is when the job starts. While its community's
  // session is not live the queue pauses and update() resumes it; a type that cannot run drops what is queued. A run that ignores
  // its deadline stops holding the queue when the deadline passes; it is not
  // otherwise fenced.
  private async drain(runner: Runner) {
    if (runner.running) return;
    runner.running = true;
    while (this.runners.get(runner.pubkey) === runner) {
      const agent = this.ready(runner.pubkey);
      const type = runner.type;
      const run = type?.run;
      // An agent this copy cannot run is left to another copy of the app.
      if (!agent || !type || !run) {
        if (agent) runner.queue.length = 0;
        await this.release(runner);
        // It may have come back into view, or gained its type, meanwhile.
        if (this.ready(runner.pubkey) !== agent || runner.type !== type)
          continue;
        break;
      }
      // Every copy of the app on this machine hears the same events; only the
      // one holding the agent runs them. Asked on every wake too, so a copy
      // takes over within a tick of the holder quitting or letting go.
      if (!(await this.claim(runner))) {
        runner.queue.length = 0;
        break;
      }
      // The agent or its type may have changed meanwhile.
      if (this.ready(runner.pubkey) !== agent || runner.type !== type) continue;
      const job = runner.queue.shift() ?? this.dueTimer(agent);
      if (!job) break;
      const lifetime = runner.controller.signal;
      const signal = AbortSignal.any([
        lifetime,
        AbortSignal.timeout(type.timeoutMs ?? 60_000),
      ]);
      const handle: AgentHandle = Object.freeze({
        pubkey: agent.pubkey,
        name: agent.name,
        owner: agent.owner,
        publish: (event: AgentEventTemplate) => this.publish(runner, event),
        query: (filters: readonly object[]) =>
          this.require().query(agent.pubkey, filters),
        upload: (data: string, mime: string) =>
          this.require().upload(agent.pubkey, data, mime),
        remember: (slug: string, body: string, after: number) =>
          this.require().remember(agent.pubkey, slug, body, after),
      });
      const working = this.working(runner, job);
      try {
        await Promise.race([
          Promise.resolve().then(async () => {
            const pick = await pickFor(job.trigger, agent, type);
            const team = teamPrompt(
              this.teamList,
              this.identities.filter((identity) => !identity.deleted),
              agent.pubkey,
            );
            signal.throwIfAborted();
            return run(
              Object.freeze({
                trigger: job.trigger,
                ...(job.channelId ? { channelId: job.channelId } : {}),
                agent: handle,
                config: agent.config,
                ...pick,
                ...(team ? { team } : {}),
                signal,
                workingUntil: working.hold,
              }),
            );
          }),
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      } catch (error) {
        if (!lifetime.aborted)
          console.error(`Agent run failed: ${agent.name}`, error);
      } finally {
        working.release();
      }
    }
    runner.running = false;
  }

  /** Counts a run as working until it and everything it handed to
   * `workingUntil` have settled, or the longest run allowed has passed. A
   * mention run is reacted to, and shown typing here, meanwhile: both are
   * STOPGAPs, and `done` is empty without them. */
  private working(runner: Runner, { trigger, channelId }: Job) {
    const native = this.native;
    const event = trigger.type === "mention" ? trigger.event : undefined;
    const channel =
      event && (channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1]);
    const done =
      native && event && channel
        ? [
            // STOPGAP(agent-working-reactions): delete with working-reactions.ts.
            reactWhileWorking(
              (template) => native.publish(runner.pubkey, template),
              event,
              channel,
            ),
            // STOPGAP(agent-local-typing): delete with local-typing.ts.
            typeLocally(
              () => {
                const relay = this.relay(runner.pubkey)?.snapshot();
                return relay?.status === "ready" ? relay.session : undefined;
              },
              runner.pubkey,
              event,
              channel,
            ),
          ]
        : [];
    let holds = 1;
    const stop = () => {
      if (holds < 0) return;
      holds = -1;
      clearTimeout(timer);
      for (const end of done) end();
    };
    const timer = setTimeout(stop, TIMEOUT_LIMIT_MS);
    const release = () => {
      if (holds > 0 && --holds === 0) stop();
    };
    return {
      hold(work: PromiseLike<unknown>) {
        if (holds <= 0) return;
        holds++;
        Promise.resolve(work).then(release, release);
      },
      release,
    };
  }

  private async claim(runner: Runner) {
    try {
      runner.mayHold = (await this.native?.claim(runner.pubkey)) ?? false;
      return runner.mayHold;
    } catch (error) {
      runner.mayHold = true;
      // Answering twice beats not answering at all.
      console.warn(
        `Agent ${this.agent(runner.pubkey)?.name} was not claimed`,
        error,
      );
      return true;
    }
  }
  private async release(runner: Runner) {
    if (!runner.mayHold) return;
    runner.mayHold = false;
    await this.native
      ?.release(runner.pubkey)
      .catch((error) =>
        console.warn(`Agent ${runner.pubkey} was not released`, error),
      );
  }
  private require() {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    return this.native;
  }
  private async publish(runner: Runner, event: AgentEventTemplate) {
    const signed = await this.require().publish(runner.pubkey, event);
    bounded(runner.wrote, signed.id);
    return signed;
  }
}
