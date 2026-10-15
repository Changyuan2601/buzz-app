// The agent runner: one queue per agent, its rate limit, mention and watch
// matching, due timers, the run deadline and the claim that lets exactly one
// host run each agent. It knows nothing of where it runs: everything it needs
// of the device, community and storage comes through its RunnerHost, so the
// desktop app and a standalone host run agents with the same code.
import type {
  Agent,
  AgentAttention,
  AgentHandle,
  RegisteredAgentType,
  Trigger,
} from "./service";
import type { LocalAgentActivity, WorkOutcome } from "./local-activity";
import { threadReference } from "../relay/thread-reference";
import {
  hasEventProof,
  type ReadFilter,
  type RelayEvent,
} from "../relay/events";
import { LANE_LIMIT, Lanes } from "../agent-harness/lanes";
import { wake } from "../agent-harness/wakes";
import { STANDALONE_DEADLINE_MS } from "../agent-harness/standalone";
import { EFFORT_TAG, MODEL_TAG } from "../relay/messages";
import type { LiveBatch } from "../relay/incoming";
import { LIVE_REPLAY_LIMIT } from "../relay/live";
import type { RelaySession } from "../relay/session";
import {
  addressedTo,
  CHAT_KINDS,
  compileFilter,
  tagsAgent,
  watchMatches,
  type AttentionObject,
  type AttentionValue,
  timerSpent,
  timerState,
  type TimerState,
  type TimerWatch,
} from "./attention";
import {
  AttentionError,
  checkedWrite,
  interestIds,
  show,
  watchSummaries,
  type ClassifierAvailability,
  type ClassifierKey,
  type WatchFilter,
  type WriteOptions,
} from "./attention-objects";
import {
  classify,
  notRun,
  type ClassifierContext,
  type ClassifierNative,
  type ClassifierOutcome,
} from "./classifier";
import type { EventWatch } from "./attention";
import type { AgentEventTemplate, AgentIdentity, AgentsNative } from "./native";
import type { AgentRecord } from "./store";
import { type Pulses, pulseTyping } from "./typing";
import {
  CATCH_UP_PAGES,
  delivered,
  HEARD_LIMIT,
  oldestFirst,
  readWindow,
  streamKey,
  streamsOf,
  undelivered,
  type Checkpoint,
  type Stream,
} from "./catch-up";

/** Jobs waiting in each lane: mentions, and watch work (catch-up included),
 * so watches can never fill the room mentions need, as in Janet. */
const QUEUE_LIMIT = 32;
/** The spec asks for at least the agent's 2,048 most recent events. */
const SEEN_LIMIT = 2_048;
/** Watched events each agent keeps while their channel's roster is only the one
 * saved on disk, until the relay confirms it. */
const HELD_LIMIT = 256;
/** Replayed events each agent keeps until it has room for them. A replay sends
 * minutes of traffic at once, which the queue and rate limit would otherwise
 * drop; past this, one is left unseen, so a later replay or catch-up can still
 * deliver it. */
const BACKLOG_LIMIT = 512;
/** Channels whose recent ids each agent keeps for replay dedup, the most
 * recently active first. */
const SEEN_CHANNELS = 128;
/** Runs per agent per minute in each lane; bounds two agents that answer
 * each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** How long catch-up waits for room in a full queue before it looks again. */
const CATCH_UP_WAIT_MS = 1_000;
/** Missed events one catch-up turn holds at most, and their most JSON
 * characters. The size is the bound that matters: 64 Ki characters is about
 * 16k–32k tokens of chat, well inside a model's context with the system
 * prompt. A lone larger event still goes; its turn shortens its text. */
const CATCH_UP_BATCH = 64;
const CATCH_UP_BATCH_CHARS = 64 * 1024;
/** Live events each watch keeps while it catches up, as Janet stages them. */
const WAITING_LIMIT = 512;
const WAITING_BYTES = 4 * 1024 * 1024;
/** How long a failed catch-up waits before it is tried again. */
const CATCH_UP_RETRY_MS = 30_000;

/** Classifier calls in flight per agent. */
const CLASSIFY_LIMIT = 32;

const bounded = (set: Set<string>, id: string, limit = SEEN_LIMIT) => {
  set.add(id);
  if (set.size > limit) set.delete(set.values().next().value as string);
};

/** The model and effort the triggering message asks of this agent. Only the
 * owner picks them, so nobody else in a channel can run the agent at their
 * level, and only ones the type lists: effort from the model the run uses. */
async function pickFor(
  trigger: Trigger,
  agent: Agent,
  type: RegisteredAgentType,
): Promise<{ model?: string; effort?: string }> {
  if (
    (trigger.type !== "mention" && trigger.type !== "watch") ||
    trigger.event.pubkey !== agent.owner
  )
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

type Job = {
  work?: ReturnType<LocalAgentActivity["begin"]>;
  trigger: Trigger;
  channelId?: string;
  /** For a watch or timer: the object and attention epoch it was matched or
   * found due under. It runs only while both are still current, so a watch or
   * timer edited, disabled, rearmed, replaced or turned off and on again since
   * then does not run it. */
  matched?: { object: AttentionObject; epoch: number };
};
type WatchTrigger = Extract<Trigger, { type: "watch" }>;
type CatchUpTrigger = Extract<Trigger, { type: "catch-up" }>;
/** Mentions and watch work queue and are rate limited apart. */
type Lane = "mention" | "watch";
const laneOf = (trigger: Trigger): Lane =>
  trigger.type === "mention" ? "mention" : "watch";
const channelOf = (event: RelayEvent) =>
  event.tags.find(([key]) => key === "h")?.[1];
/** The key of the catch-up stream that `trigger`'s event is in, for a kind 9
 * watch; others have none. */
const streamOf = (pubkey: string, { watch, slug, event }: WatchTrigger) =>
  watch.kinds.length === 1 && watch.kinds[0] === 9
    ? streamKey(
        pubkey,
        slug,
        watch.channels === "all" ? undefined : channelOf(event),
      )
    : undefined;
/** Classifier calls a trigger's job makes before it queues. */
const classifications = (trigger: Trigger) =>
  trigger.type === "watch" && trigger.watch.classifier
    ? 1
    : trigger.type === "catch-up" && trigger.watch.classifier
      ? trigger.events.length
      : 0;
const sizeOf = (event: RelayEvent) => JSON.stringify(event).length;
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
  /** Events waiting to run in each lane, mentions first; due timers are found
   * when a run starts instead. */
  readonly queues: Record<Lane, Job[]>;
  running: boolean;
  /** Each lane's runs in the current minute. */
  readonly rates: Record<Lane, { windowStart: number; admitted: number }>;
  /** Watches catching up now, whose live events wait in `waiting` until they
   * have, so the older events come first. */
  catching: ReadonlySet<string>;
  readonly waiting: Map<string, { jobs: Job[]; bytes: number }>;
  /** Watch jobs released from `waiting`, oldest first, going into the queue
   * as it has room. */
  readonly later: Job[];
  /** Events seen, and events it wrote (so reactions to them reach no watch). */
  readonly seen: Set<string>;
  /** Events seen in each channel, as many as a reconnect replays of it, so
   * other channels' traffic cannot push out one a replay sends again. Only the
   * `SEEN_CHANNELS` most recently active channels are kept. */
  readonly seenIn: Map<string, Set<string>>;
  /** Replayed events waiting, oldest first, until the agent has room for the
   * jobs each makes. */
  readonly backlog: { event: RelayEvent; channelId?: string }[];
  /** A missed event catch-up is still giving out, and the watches that have
   * it: it makes more watch jobs than the agent has room for at once. */
  fanning?: { id: string; done: ReadonlySet<string> };
  readonly wrote: Set<string>;
  /** Turns still counted as working, which a change of type waits out. */
  working: number;
  /** Its typing pulses, one per conversation it is working in. */
  readonly typing: Pulses;
  /** A provider/config transition owns the idle runner and pauses its queue. */
  transitioning: boolean;
  /** Watched events whose channel roster is not confirmed yet, by id: they are
   * matched again once it is (see `RunnerHost.member`). */
  readonly held: Map<string, { event: RelayEvent; channelId?: string }>;
  /** Whether native may hold the agent for this copy; true at first, since
   * native outlives a page reload. */
  mayHold: boolean;
  activityClaimed?: boolean;
  /** Advances each time attention is seen off, which voids queued watch work. */
  epoch: number;
  /** Watch and timer turns for a type with `runOnce`, one lane per Interest. */
  lanes: Lanes;
  /** Watch jobs taken from the queue and not yet given to their lane. */
  handing: number;
  /** Whether a claim has been answered, so `mayHold` is known rather than
   * assumed. */
  asked?: boolean;
  /** Classified watch events not yet queued or dropped. Each counts against
   * the queue and rate room a catch-up page needs. */
  classifying: number;
  /** The last classified event's release: results queue in arrival order. */
  classified: Promise<void>;
  compiled?: {
    attention: Agent["attention"];
    watches: readonly CompiledWatch[];
  };
};

/** The session's live connection: `since` is when it last connected, and is
 * absent while it is down; `epoch` counts its connects; `start` is when its
 * listener started, from which live events, replay included, are heard. */
export type Connection = {
  epoch: number;
  start: number;
  since?: number | undefined;
};
/** An agent's community while it is live: one object for as long as its
 * session lasts. */
export type LiveCommunity = {
  readonly session: Pick<RelaySession, "read">;
  /** Aborts when the session is replaced, so no work outlives it. */
  readonly controller: AbortController;
  readonly connection: Connection;
};
/** One agent's catch-up, for the attention, community and connect it started
 * under; any of them changing starts another. */
type Pass = {
  attention: Agent["attention"];
  community: LiveCommunity;
  epoch: number;
  controller: AbortController;
  done?: boolean;
  failedAt?: number;
};

const EMPTY = Object.freeze({});
const blank = (pubkey: string): AgentRecord => ({
  pubkey,
  attention: EMPTY,
  config: undefined,
});
const seconds = () => Math.floor(Date.now() / 1000);
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);

/** What the runner needs of its host. */
export type RunnerHost = {
  /** The agent, while its community is live to run it in. */
  ready(pubkey: string): Agent | undefined;
  /** A running agent, in any community. */
  agent(pubkey: string): Agent | undefined;
  /** Whether the agent is in the event's channel, or undefined while its
   * roster is only the one saved on disk and the relay has not confirmed it. */
  member(agent: Agent, event: RelayEvent): boolean | undefined;
  /** Whether the event's channel is a DM between the agent and one other. */
  dm(agent: Agent, event: RelayEvent): boolean;
  /** Its community, while live. */
  community(agent: Agent): LiveCommunity | undefined;
  /** Every saved record, whose watches' catch-up progress is kept. */
  records(): readonly AgentRecord[];
  /** Catch-up progress, as saved. */
  checkpoints: {
    read(): Readonly<Record<string, Checkpoint>>;
    /** Throws when storage refuses it. */
    write(checkpoints: Readonly<Record<string, Checkpoint>>): void;
  };
  /** The partition its community's activity is kept under, while live. */
  scope(agent: Agent): string | undefined;
  /** Its saved record, without defaults. */
  saved(pubkey: string): AgentRecord | undefined;
  /** Its record as its attention handle reads it; throws once it is gone. */
  record(pubkey: string): AgentRecord;
  /** Saves one record; throws when storage refuses it. */
  write(record: AgentRecord): void;
  /** The team sections of its prompt; empty without a team. */
  team(pubkey: string): string;
  /** The owner's channel templates as the agent's handle offers them. */
  templates(agent: Agent): ReturnType<AgentHandle["templates"]>;
  /** Whether watch classifiers can run here. */
  classifier(): ClassifierAvailability;
  /** The classifier, where one can run. */
  jev(): ClassifierNative | undefined;
  /** Settles once the saved key's status is known; until then a classified
   * event waits rather than pass unchecked. */
  jevStatus(): Promise<void> | undefined;
  /** What is known about the saved classifier key. */
  classifierKey(): ClassifierKey;
  /** Changes each time the owner saves or removes the key. */
  classifierKeyGeneration(): number;
  /** What a classifier call that started under `generation` found out about
   * the saved key; ignored once the key has changed since. */
  setClassifierKey(key: ClassifierKey, generation: number): void;
  /** The event's surroundings for the classifier. */
  context(agent: Agent, event: RelayEvent): Promise<ClassifierContext>;
  /** A person's name as the agent's community shows it. */
  displayName(agent: Agent, pubkey: string): string | null;
  /** Signs, reads and claims as each agent; absent where agents cannot run. */
  custody:
    | Pick<
        AgentsNative,
        | "claim"
        | "release"
        | "publish"
        | "query"
        | "upload"
        | "media"
        | "remember"
      >
    | undefined;
  /** This device's view of each agent's work. */
  activity: LocalAgentActivity;
  /** Whether a mention in `channel` continues the agent's owner's Me chat,
   * so its turn answers, and shows typing, at channel top level. */
  meChat(agent: Agent, channel: string, signal: AbortSignal): Promise<boolean>;
};

export class AgentRunners {
  private readonly runners = new Map<string, Runner>();
  /** Agents whose community was live at the last resume. */
  private connected = new Set<string>();
  /** Catch-up progress of each kind 9 watch stream, as saved. */
  private checkpoints: Readonly<Record<string, Checkpoint>>;
  /** By agent, its catch-up running or last run. */
  private passes = new Map<string, Pass>();
  /** Streams seen off (their watch disabled or the agent's attention off)
   * since the host started. One turned on starts from then, so it wakes
   * nothing from the time it was off; across a restart, its saved
   * checkpoint, moved while it was off, does the same. */
  private quiet = new Set<string>();
  constructor(private readonly host: RunnerHost) {
    this.checkpoints = host.checkpoints.read();
  }

  /** Keeps one runner for each saved agent: a deleted one's is retired, and a
   * replaced type aborts its run. Turning attention off voids the watch work
   * it queued, even if it is turned on again before that work would run. */
  reconcile(
    identities: readonly Pick<AgentIdentity, "pubkey" | "type">[],
    types: ReadonlyMap<string, RegisteredAgentType>,
  ) {
    for (const [pubkey, runner] of this.runners)
      if (!identities.some((identity) => identity.pubkey === pubkey)) {
        this.retire(runner);
        this.runners.delete(pubkey);
      }
    for (const identity of identities) {
      const type = types.get(identity.type);
      const runner = this.runners.get(identity.pubkey);
      if (
        runner &&
        this.host.saved(identity.pubkey)?.attentionEnabled !== true
      ) {
        runner.epoch++;
        this.dropWatchWork(runner);
        runner.lanes.clear();
      }
      if (!runner)
        this.runners.set(identity.pubkey, this.runner(identity, type));
      else if (runner.type !== type) {
        runner.controller.abort();
        runner.controller = new AbortController();
        runner.lanes.stop();
        runner.lanes = new Lanes();
        runner.type = type;
        void this.drain(runner);
      }
    }
  }
  /** Resumes runners whose queue paused while their community was not live,
   * and claims or releases each agent as its community goes live or not, so
   * another host takes over without waiting for an event or tick. `ready` is
   * the agents whose community is live now. */
  resume(ready: ReadonlySet<string>) {
    for (const runner of this.runners.values())
      if (
        runner.queues.mention.length ||
        runner.queues.watch.length ||
        ready.has(runner.pubkey) !== this.connected.has(runner.pubkey)
      )
        void this.drain(runner);
    this.connected = new Set(ready);
  }
  /** Wakes each runner, which starts any timer that is due. */
  tick() {
    for (const runner of this.runners.values()) {
      this.admit(runner);
      void this.drain(runner);
    }
  }
  /** Whether this copy runs the agent: its type can run it, and no other
   * copy of the app holds it. */
  runs(pubkey: string) {
    const runner = this.runners.get(pubkey);
    return !!runner?.type?.run && !!runner.asked && runner.mayHold;
  }
  /** Whether another copy of the app runs an agent this one could. */
  yielded(pubkey: string) {
    const runner = this.runners.get(pubkey);
    return !!runner?.type?.run && !runner.mayHold && !!this.host.ready(pubkey);
  }
  /** Whether a change of type holds the agent's runner now. */
  transitioning(pubkey: string) {
    return this.runners.get(pubkey)?.transitioning === true;
  }
  /** Runs `change` while a change of type holds the agent's idle runner: no
   * turn starts meanwhile, and its queue resumes after. Refused while a turn
   * is working, and unless this copy of the app holds the agent. */
  async retype<T>(
    pubkey: string,
    name: string,
    change: () => Promise<T>,
  ): Promise<T> {
    const runner = this.runners.get(pubkey);
    const answering = () =>
      new Error(`${name} is answering; change its type when it finishes`);
    if (runner?.working) throw answering();
    if (!runner)
      throw new Error(
        "This agent is not running in this copy of Buzz. Change its provider in the Buzz app that runs it.",
      );
    if (runner.transitioning)
      throw new Error(`${name}'s provider is already changing`);
    runner.transitioning = true;
    try {
      if (!(await this.claimForRetype(runner)))
        throw new Error(
          "Another copy of Buzz is running this agent. Change its provider there, or quit that copy of Buzz and try again.",
        );
      if (runner.working) throw answering();
      return await change();
    } finally {
      runner.transitioning = false;
      void this.drain(runner);
    }
  }
  /** Retires every runner, as when the host stops. */
  clear() {
    for (const runner of this.runners.values()) this.retire(runner);
    this.runners.clear();
  }

  private runner(
    identity: Pick<AgentIdentity, "pubkey">,
    type: RegisteredAgentType | undefined,
  ): Runner {
    return {
      pubkey: identity.pubkey,
      type,
      controller: new AbortController(),
      queues: { mention: [], watch: [] },
      running: false,
      rates: {
        mention: { windowStart: 0, admitted: 0 },
        watch: { windowStart: 0, admitted: 0 },
      },
      catching: new Set(),
      waiting: new Map(),
      later: [],
      seen: new Set(),
      seenIn: new Map(),
      backlog: [],
      wrote: new Set(),
      working: 0,
      typing: new Map(),
      transitioning: false,
      held: new Map(),
      mayHold: true,
      epoch: 0,
      lanes: new Lanes(),
      handing: 0,
      classifying: 0,
      classified: Promise.resolve(),
    };
  }
  private retire(runner: Runner) {
    this.passes.get(runner.pubkey)?.controller.abort();
    this.passes.delete(runner.pubkey);
    this.host.activity.clear(undefined, runner.pubkey);
    runner.queues.mention.length = 0;
    this.dropWatchWork(runner);
    runner.held.clear();
    runner.backlog.length = 0;
    runner.controller.abort();
    runner.lanes.stop();
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
        ...(watch.filter ? { filter: compileFilter(watch.filter) } : {}),
      });
    }
    runner.compiled = { attention: agent.attention, watches };
    return watches;
  }

  /** Gives a community's live events, and replayed ones from `since` on, to
   * the agents in it. */
  dispatch(batch: LiveBatch, heard: (agent: Agent) => boolean, since: number) {
    for (const runner of this.runners.values()) {
      const agent = this.host.ready(runner.pubkey);
      if (!agent || !heard(agent) || !runner.type?.run) continue;
      let overflow = 0;
      for (const event of batch.events) {
        if (batch.replay && event.created_at < since) continue;
        if (!batch.replay) {
          this.hear(runner, agent, event, batch.channelId);
          continue;
        }
        const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (this.hasSeen(runner, event.id, channel)) continue;
        // Left unseen, so a later replay or catch-up can still deliver it.
        if (runner.backlog.length >= BACKLOG_LIMIT) {
          overflow++;
          continue;
        }
        this.markSeen(runner, event.id, channel);
        if (this.isOwn(runner, agent, event)) continue;
        // A replay waits for room rather than take the drops a burst of
        // live traffic would.
        runner.backlog.push({
          event,
          ...(batch.channelId ? { channelId: batch.channelId } : {}),
        });
      }
      if (overflow)
        console.warn(
          `Agent ${agent.name} left ${overflow} replayed events for later`,
        );
      if (batch.replay) this.admit(runner);
    }
  }
  private hasSeen(runner: Runner, id: string, channel: string | undefined) {
    return (
      runner.seen.has(id) ||
      (!!channel && !!runner.seenIn.get(channel)?.has(id))
    );
  }
  /** An agent never hears itself; its own events keep reactions to them from
   * its watches. */
  private isOwn(runner: Runner, agent: Agent, event: RelayEvent) {
    if (event.pubkey !== agent.pubkey) return false;
    bounded(runner.wrote, event.id);
    return true;
  }
  private markSeen(runner: Runner, id: string, channel: string | undefined) {
    bounded(runner.seen, id);
    if (!channel) return;
    const ids = runner.seenIn.get(channel) ?? new Set<string>();
    // Moved to the newest end, so the quietest channel is forgotten first.
    runner.seenIn.delete(channel);
    runner.seenIn.set(channel, ids);
    bounded(ids, id, LIVE_REPLAY_LIMIT);
    if (runner.seenIn.size > SEEN_CHANNELS)
      runner.seenIn.delete(runner.seenIn.keys().next().value as string);
  }
  /** The most watch jobs an idle agent takes at once. A type with `runOnce`
   * hands each to an Interest's lane, which keeps fewer waiting than the
   * queue does. Turns waiting in every lane count against one lane's limit,
   * so no lane fills and drops one. */
  private watchLimit(runner: Runner) {
    return runner.type?.runOnce ? LANE_LIMIT : QUEUE_LIMIT;
  }
  /** Whether the agent can take `jobs` more jobs, `classified` of them first
   * through the classifier, without dropping any. Events still being
   * classified will take queue and rate room too, and queued watch jobs lane
   * room. */
  private fits(
    runner: Runner,
    mentions: number,
    watches: number,
    classified: number,
  ) {
    const admitted = (lane: Lane) => {
      const rate = runner.rates[lane];
      return Date.now() - rate.windowStart >= RATE_WINDOW_MS
        ? 0
        : rate.admitted;
    };
    const { mention, watch } = runner.queues;
    return (
      mention.length + mentions <= QUEUE_LIMIT &&
      admitted("mention") + mentions <= RATE_LIMIT &&
      watch.length +
        runner.classifying +
        (runner.type?.runOnce ? runner.handing + runner.lanes.pending : 0) +
        watches <=
        this.watchLimit(runner) &&
      runner.classifying + classified <= CLASSIFY_LIMIT &&
      admitted("watch") + runner.classifying + watches <= RATE_LIMIT
    );
  }
  /** Whether the agent has room for every job `triggers` make. One that
   * makes more jobs than an idle agent takes goes when it is idle, and loses
   * the excess as live delivery would. */
  private takes(runner: Runner, triggers: readonly Trigger[]) {
    const mentions = triggers.filter((t) => t.type === "mention").length;
    return this.fits(
      runner,
      Math.min(mentions, QUEUE_LIMIT),
      Math.min(triggers.length - mentions, this.watchLimit(runner)),
      Math.min(
        triggers.reduce((sum, t) => sum + classifications(t), 0),
        CLASSIFY_LIMIT,
      ),
    );
  }
  /** Delivers backlogged events, oldest first, while the agent has room for
   * every job each makes; the rest wait for a later tick. Each is matched
   * against the agent's attention as it is when it is delivered. */
  private admit(runner: Runner) {
    const agent = this.host.ready(runner.pubkey);
    if (!agent || !runner.type?.run) return;
    // First the live events held back while their watch caught up.
    while (runner.later.length) {
      const job = runner.later[0] as Job;
      if (!this.fits(runner, 0, 1, classifications(job.trigger))) return;
      runner.later.shift();
      this.submit(runner, agent, job);
    }
    while (runner.backlog.length) {
      const { event, channelId } = runner.backlog[0] as Runner["backlog"][0];
      const triggers = this.heard(runner, agent, event);
      if (
        triggers === "held"
          ? runner.held.size >= HELD_LIMIT
          : !this.takes(runner, triggers)
      )
        return;
      runner.backlog.shift();
      this.deliver(runner, agent, event, channelId, triggers);
    }
  }
  /** Gives the agent `event` once, however many times it arrives. */
  private hear(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    channelId: string | undefined,
  ) {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (this.hasSeen(runner, event.id, channel)) return;
    this.markSeen(runner, event.id, channel);
    if (this.isOwn(runner, agent, event)) return;
    this.deliver(runner, agent, event, channelId);
  }
  /** Saves `event` as heard by each of the agent's streams it is in and has
   * not passed yet, so catch-up after a restart does not give it again. */
  private heardLive(agent: Agent, event: RelayEvent) {
    if (event.kind !== 9) return;
    const channel = channelOf(event);
    let changed = false;
    for (const stream of streamsOf(agent))
      if (stream.channel === undefined || stream.channel === channel)
        changed = this.heardIn(stream.key, event) || changed;
    if (changed) this.saveCheckpoints();
  }
  /** Adds `event` to what the stream heard past its checkpoint, unless it is
   * not past it; returns whether it did. */
  private heardIn(key: string, event: RelayEvent) {
    const checkpoint = this.checkpoints[key];
    if (!checkpoint || !undelivered(checkpoint, event)) return false;
    const heard = [
      ...(checkpoint.heard ?? []),
      { created_at: event.created_at, id: event.id },
    ];
    this.checkpoints = {
      ...this.checkpoints,
      [key]: { ...checkpoint, heard: heard.slice(-HEARD_LIMIT) },
    };
    return true;
  }
  /** Sets a stream's checkpoint, keeping what it heard live past it. */
  private setCheckpoint(key: string, checkpoint: Checkpoint) {
    const heard = this.checkpoints[key]?.heard?.filter((event) =>
      undelivered({ ...checkpoint, heard: [] }, event),
    );
    this.checkpoints = {
      ...this.checkpoints,
      [key]: heard?.length ? { ...checkpoint, heard } : checkpoint,
    };
  }
  /** Keeps each agent's catch-up going: on start, and after each connect, its
   * kind 9 watches read the events they missed from their saved checkpoints,
   * up to the connect. From then on live events cover them, so while the
   * connection stays up a `tick` moves their checkpoints to now; a quit or a
   * drop leaves the checkpoint where the next catch-up starts. */
  catchUp(tick: boolean) {
    const now = seconds();
    let changed = false;
    const move = (key: string, checkpoint: Checkpoint) => {
      this.setCheckpoint(key, checkpoint);
      changed = true;
    };
    for (const runner of this.runners.values()) {
      const agent = this.host.agent(runner.pubkey);
      const community = agent && this.host.community(agent);
      const on = !!agent?.attentionEnabled && !!runner.type?.run;
      const reading: Stream[] = [];
      for (const stream of agent ? streamsOf(agent) : []) {
        if (!on || !stream.enabled) {
          // Saved too, so one turned on after a restart starts from about
          // when this copy last saw it off.
          this.quiet.add(stream.key);
          if ((this.checkpoints[stream.key]?.through ?? 0) < now)
            move(stream.key, { through: now });
        } else if (
          this.quiet.delete(stream.key) ||
          !this.checkpoints[stream.key]
        )
          // A stream new to catch-up, as every one is on an upgrade, starts
          // now: an earlier `since` does not replay older events.
          move(stream.key, { through: now });
        else reading.push(stream);
      }
      const pass = this.passes.get(runner.pubkey);
      const since = community?.connection.since;
      if (!agent || !community || since === undefined || !reading.length) {
        pass?.controller.abort();
        this.passes.delete(runner.pubkey);
        this.setCatching(runner, new Set());
        continue;
      }
      if (
        pass?.attention === agent.attention &&
        pass.community === community &&
        pass.epoch === community.connection.epoch &&
        !(pass.failedAt && Date.now() - pass.failedAt >= CATCH_UP_RETRY_MS)
      ) {
        if (pass.done && tick)
          for (const { key } of reading) {
            const checkpoint = this.checkpoints[key];
            if (checkpoint && !checkpoint.upper && checkpoint.through < now)
              move(key, { through: now });
          }
        continue;
      }
      pass?.controller.abort();
      const next: Pass = {
        attention: agent.attention,
        community,
        epoch: community.connection.epoch,
        controller: new AbortController(),
      };
      this.passes.set(runner.pubkey, next);
      this.setCatching(runner, new Set(reading.map(({ slug }) => slug)));
      void this.readMissed(runner, next, reading, since);
    }
    if (changed) this.saveCheckpoints();
  }
  /** Reads each stream's missed events through `upper`, a window at a time,
   * and delivers them oldest first, in batches, saving its checkpoint after
   * each. A watch's streams are read one after another; once all of them are
   * read, its live events that waited go on. */
  private async readMissed(
    runner: Runner,
    pass: Pass,
    streams: readonly Stream[],
    upper: number,
  ) {
    const signal = AbortSignal.any([
      pass.controller.signal,
      pass.community.controller.signal,
    ]);
    const name = () => this.host.agent(runner.pubkey)?.name;
    const read = async (filter: ReadFilter) => {
      const events = await pass.community.session.read([filter], {
        signal,
        priority: "background",
        fresh: true,
      });
      signal.throwIfAborted();
      // Only what the relay signed: a read also returns the owner's own
      // messages not yet sent, which can be older than its page.
      return events.filter(hasEventProof) as RelayEvent[];
    };
    const progress = (key: string, checkpoint: Checkpoint) => {
      this.setCheckpoint(key, checkpoint);
      this.saveCheckpoints();
    };
    try {
      const slugs = [...new Set(streams.map(({ slug }) => slug))];
      for (const slug of slugs) {
        for (const stream of streams.filter((item) => item.slug === slug))
          for (;;) {
            const window = await readWindow(
              stream,
              this.checkpoints[stream.key],
              upper,
              read,
            );
            if (!window) break;
            if (window.skipped)
              console.warn(
                `Agent ${name()} skipped the oldest events ${slug} missed: catch-up reads at most ${CATCH_UP_PAGES} pages`,
              );
            progress(stream.key, window.checkpoint);
            const events = window.events.filter((event) => event.kind === 9);
            let skipped = window.skipped;
            for (let index = 0; index < events.length; ) {
              const taken = await this.caughtUp(
                runner,
                pass,
                slug,
                events.slice(index, index + CATCH_UP_BATCH),
                skipped,
                signal,
              );
              if (!taken) return;
              skipped = false;
              index += taken;
              const last = events[index - 1] as RelayEvent;
              progress(stream.key, delivered(window.upper, last));
            }
            progress(stream.key, delivered(window.upper));
          }
        const catching = new Set(runner.catching);
        catching.delete(slug);
        this.setCatching(runner, catching);
      }
      pass.done = true;
    } catch (error) {
      if (signal.aborted) return;
      pass.failedAt = Date.now();
      // Live events go on rather than wait for the next try.
      this.setCatching(runner, new Set());
      console.warn(`Agent ${name()} could not catch up`, error);
    }
  }
  /** Gives the agent the first of `events` it has room for, once the rosters
   * their watches need are confirmed: a checkpoint saved past an event never
   * drops or evicts it. One that makes more jobs than the agent has room for
   * goes to its watches a few at a time. Each watch they match gets one
   * job with all of its events, oldest first, so a long absence does not
   * cost a turn per message. One from before the listener started wakes only
   * watches, so a mention from before the app listened is not answered late.
   * A later one live would have heard, mentions too; catch-up may read it
   * before replay does, which then skips it as seen. Returns how many events
   * were taken, or 0 when an edit since ends the pass: the next one reads them
   * again. */
  private async caughtUp(
    runner: Runner,
    pass: Pass,
    slug: string,
    events: readonly RelayEvent[],
    skipped: boolean,
    signal: AbortSignal,
  ): Promise<number> {
    for (;;) {
      signal.throwIfAborted();
      const agent = this.host.ready(runner.pubkey);
      if (agent?.attention !== pass.attention) return 0;
      const taken = this.batch(runner, agent, pass, slug, events, skipped);
      if (taken) return taken;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, CATCH_UP_WAIT_MS);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  /** Delivers the longest run of `events`, oldest first, whose jobs the agent
   * has room for now; returns how many it took, or 0 for none. With no room
   * for all of the first one's, what room there is goes to some of them. */
  private batch(
    runner: Runner,
    agent: Agent,
    pass: Pass,
    slug: string,
    events: readonly RelayEvent[],
    skipped: boolean,
  ) {
    const mentions: { trigger: Trigger; channel?: string }[] = [];
    const watches = new Map<string, WatchTrigger[]>();
    let taken = 0;
    let bytes = 0;
    for (const event of events) {
      const channel = channelOf(event);
      // Seen once its first watches have it; the rest still get it.
      const fanning =
        runner.fanning?.id === event.id ? runner.fanning : undefined;
      const heard =
        (!fanning && this.hasSeen(runner, event.id, channel)) ||
        event.pubkey === agent.pubkey
          ? []
          : this.heard(runner, agent, event);
      if (heard === "held") break;
      const listened = event.created_at >= pass.community.connection.start;
      const triggers = heard.filter((trigger) =>
        trigger.type === "watch"
          ? !fanning?.done.has(trigger.slug) &&
            this.missed(runner, trigger, listened)
          : !fanning && listened,
      );
      const nextMentions = [...mentions];
      const nextWatches = new Map(
        [...watches].map(([key, list]) => [key, [...list]]),
      );
      for (const trigger of triggers)
        if (trigger.type === "watch")
          nextWatches.set(trigger.slug, [
            ...(nextWatches.get(trigger.slug) ?? []),
            trigger,
          ]);
        else nextMentions.push({ trigger, ...(channel ? { channel } : {}) });
      const classified = [...nextWatches.values()].reduce(
        (sum, list) => sum + (list[0]?.watch.classifier ? list.length : 0),
        0,
      );
      const size = sizeOf(event);
      if (taken && bytes + size > CATCH_UP_BATCH_CHARS) break;
      if (
        !this.fits(runner, nextMentions.length, nextWatches.size, classified)
      ) {
        if (!taken) this.fanOut(runner, agent, event, triggers, slug, skipped);
        break;
      }
      mentions.splice(0, mentions.length, ...nextMentions);
      watches.clear();
      for (const [key, list] of nextWatches) watches.set(key, list);
      bytes += size;
      taken++;
    }
    if (!taken) return 0;
    for (const event of events.slice(0, taken)) {
      if (runner.fanning?.id === event.id) delete runner.fanning;
      const channel = channelOf(event);
      if (this.hasSeen(runner, event.id, channel)) continue;
      this.markSeen(runner, event.id, channel);
      this.isOwn(runner, agent, event);
    }
    this.give(runner, agent, mentions, watches, slug, skipped);
    return taken;
  }
  /** Gives a missed event that makes more jobs than the agent has room for
   * to as many of its watches as there is room for now; later tries give it
   * to the rest, and only then is it taken, so its checkpoint never passes a
   * watch that did not get it. It is seen from the first, so a replay does
   * not give it again. */
  private fanOut(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    triggers: readonly Trigger[],
    slug: string,
    skipped: boolean,
  ) {
    const channel = channelOf(event);
    const mentions = triggers
      .filter((trigger) => trigger.type !== "watch")
      .map((trigger) => ({ trigger, ...(channel ? { channel } : {}) }));
    const watches = new Map<string, WatchTrigger[]>();
    let classified = 0;
    for (const trigger of triggers) {
      if (trigger.type !== "watch") continue;
      const more = trigger.watch.classifier ? 1 : 0;
      if (
        !this.fits(runner, mentions.length, watches.size + 1, classified + more)
      )
        break;
      watches.set(trigger.slug, [trigger]);
      classified += more;
    }
    if (!watches.size) return;
    if (!this.hasSeen(runner, event.id, channel))
      this.markSeen(runner, event.id, channel);
    // Saved for each watch's stream too, so a restart before the rest have it
    // does not give it to these again.
    let changed = false;
    for (const [trigger] of watches.values()) {
      const stream = streamOf(runner.pubkey, trigger as WatchTrigger);
      if (stream) changed = this.heardIn(stream, event) || changed;
    }
    if (changed) this.saveCheckpoints();
    const done = runner.fanning?.id === event.id ? runner.fanning.done : [];
    runner.fanning = {
      id: event.id,
      done: new Set([...done, ...watches.keys()]),
    };
    this.give(runner, agent, mentions, watches, slug, skipped);
  }
  /** Queues catch-up's mentions, and one job per watch with its events. */
  private give(
    runner: Runner,
    agent: Agent,
    mentions: readonly { trigger: Trigger; channel?: string }[],
    watches: ReadonlyMap<string, readonly WatchTrigger[]>,
    slug: string,
    skipped: boolean,
  ) {
    for (const { trigger, channel } of mentions)
      this.enqueue(runner, {
        trigger,
        ...(channel ? { channelId: channel } : {}),
      });
    for (const [key, list] of watches) {
      const [{ watch, interest }] = list as [WatchTrigger];
      this.submit(runner, agent, {
        trigger: {
          type: "catch-up",
          slug: key,
          watch,
          ...(interest ? { interest } : {}),
          events: list.map(({ event }) => ({ event })),
          ...(skipped && key === slug ? { skipped } : {}),
        },
        matched: {
          object: agent.attention[key] as AttentionObject,
          epoch: runner.epoch,
        },
      });
    }
  }
  /** Whether a catch-up event read for one watch is also one `trigger`'s
   * watch missed. One with its own stream missed it while it is past that
   * stream's checkpoint, so a watch added or widened since wakes for nothing
   * older; one with none has replay only, from when the app listened. */
  private missed(runner: Runner, trigger: WatchTrigger, listened: boolean) {
    const stream = streamOf(runner.pubkey, trigger);
    if (!stream) return listened;
    const checkpoint = this.checkpoints[stream];
    return !!checkpoint && undelivered(checkpoint, trigger.event);
  }
  /** Saves the checkpoints of watches that still exist. Unsaved, catch-up
   * starts from the last saved one again, which `seen` dedupes until a
   * restart, and each stream's saved `heard` after one. */
  private saveCheckpoints() {
    const keys = new Set(
      this.host
        .records()
        .flatMap((record) => streamsOf(record).map((stream) => stream.key)),
    );
    this.checkpoints = Object.fromEntries(
      Object.entries(this.checkpoints).filter(([key]) => keys.has(key)),
    );
    try {
      this.host.checkpoints.write(this.checkpoints);
    } catch (error) {
      console.warn("Agent catch-up progress was not saved", error);
    }
  }
  /** Matches the held events of a community's agents again, as its rosters
   * change: one now confirmed wakes the watches it matches, or none. They go
   * back through the backlog, ahead of what came after them: a confirmed
   * roster can release more than the agent has room for at once, and each is
   * already seen, so one dropped here would never come again. */
  releaseHeld(heard: (agent: Agent) => boolean) {
    for (const runner of this.runners.values()) {
      if (!runner.held.size) continue;
      const agent = this.host.ready(runner.pubkey);
      if (!agent || !heard(agent)) continue;
      runner.backlog.unshift(...runner.held.values());
      runner.held.clear();
      this.admit(runner);
    }
  }
  private deliver(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    channelId: string | undefined,
    triggers = this.heard(runner, agent, event),
  ) {
    if (triggers === "held") {
      runner.held.set(event.id, { event, ...(channelId ? { channelId } : {}) });
      if (runner.held.size > HELD_LIMIT) {
        runner.held.delete(runner.held.keys().next().value as string);
        console.warn(
          `Agent ${agent.name} dropped a watched event its roster held`,
        );
      }
      return;
    }
    this.heardLive(agent, event);
    for (const trigger of triggers) {
      const job = {
        trigger,
        ...(channelId ? { channelId } : {}),
        ...(trigger.type === "watch"
          ? {
              matched: {
                object: agent.attention[trigger.slug] as AttentionObject,
                epoch: runner.epoch,
              },
            }
          : {}),
      };
      if (trigger.type === "watch" && runner.catching.has(trigger.slug))
        this.wait(runner, agent, trigger.slug, job);
      else this.submit(runner, agent, job);
    }
  }
  private submit(runner: Runner, agent: Agent, job: Job) {
    const { trigger } = job;
    if (
      (trigger.type === "watch" || trigger.type === "catch-up") &&
      trigger.watch.classifier
    )
      this.classified(runner, agent, { ...job, trigger });
    else this.enqueue(runner, job);
  }
  /** Keeps a live event of a watch catching up until it has, as Janet stages
   * them. Past Janet's bounds the watch stops waiting: what it kept goes on
   * now, out of order, rather than be lost. */
  private wait(runner: Runner, agent: Agent, slug: string, job: Job) {
    const waiting = runner.waiting.get(slug) ?? { jobs: [], bytes: 0 };
    runner.waiting.set(slug, waiting);
    waiting.jobs.push(job);
    waiting.bytes += sizeOf((job.trigger as WatchTrigger).event);
    if (waiting.jobs.length <= WAITING_LIMIT && waiting.bytes <= WAITING_BYTES)
      return;
    console.warn(
      `Agent ${agent.name} heard too much for ${slug} while it caught up; it goes on out of order`,
    );
    const catching = new Set(runner.catching);
    catching.delete(slug);
    this.setCatching(runner, catching);
  }
  /** Sets the watches catching up; the live events of any others that
   * waited go on, oldest first, as the agent has room. */
  private setCatching(runner: Runner, catching: ReadonlySet<string>) {
    runner.catching = catching;
    const released: Job[] = [];
    for (const [slug, { jobs }] of runner.waiting)
      if (!catching.has(slug)) {
        runner.waiting.delete(slug);
        released.push(...jobs);
      }
    if (!released.length) return;
    const event = (job: Job) => (job.trigger as WatchTrigger).event;
    runner.later.push(
      ...released.sort((a, b) => oldestFirst(event(a), event(b))),
    );
    this.admit(runner);
  }
  /** Voids the agent's queued and waiting watch work. */
  private dropWatchWork(runner: Runner) {
    runner.queues.watch.length = 0;
    runner.later.length = 0;
    runner.waiting.clear();
  }
  /** Runs a matched watch's classifier, then queues the event if it passes.
   * The classifier runs after the watch's selectors and filter, and before the
   * event takes a queue slot, as in Janet. Without a key, or when it fails,
   * the event passes and its turn is told why. Results queue in the order the
   * events arrived, whichever call finishes first. A catch-up's events are
   * each classified, and the ones that pass queue together. */
  private classified(
    runner: Runner,
    agent: Agent,
    job: Job & { trigger: WatchTrigger | CatchUpTrigger },
  ) {
    const { trigger } = job;
    const events =
      trigger.type === "watch"
        ? [trigger.event]
        : trigger.events.map(({ event }) => event);
    // Never bypassed: past the limit the event is dropped, like a full queue.
    if (runner.classifying + events.length > CLASSIFY_LIMIT) {
      console.warn(`Agent ${agent.name} dropped an event to classify`);
      return;
    }
    runner.classifying += events.length;
    const lifetime = runner.controller.signal;
    // Whether this runner, as it is now, should still act on the event.
    const live = () =>
      !lifetime.aborted &&
      this.runners.get(runner.pubkey) === runner &&
      this.stillCurrent(runner, job);
    // Checked as non-null by the caller.
    const classifier = trigger.watch.classifier as NonNullable<
      EventWatch["classifier"]
    >;
    const outcomes = Promise.all(
      events.map((event) =>
        this.classify(runner, agent, classifier, event, live).catch((error) => {
          console.warn(
            `Agent ${agent.name} could not classify an event`,
            error,
          );
          return undefined;
        }),
      ),
    );
    const previous = runner.classified;
    runner.classified = (async () => {
      try {
        await previous;
        const results = await outcomes;
        // A retired or replaced runner keeps none of its work.
        if (lifetime.aborted || this.runners.get(runner.pubkey) !== runner)
          return;
        if (trigger.type === "watch") {
          const [result] = results;
          if (result)
            this.enqueue(runner, {
              ...job,
              trigger: { ...trigger, classifier: result },
            });
          return;
        }
        const passed = events.flatMap((event, index) => {
          const result = results[index];
          return result ? [{ event, classifier: result }] : [];
        });
        if (passed.length)
          this.enqueue(runner, {
            ...job,
            trigger: { ...trigger, events: passed },
          });
      } finally {
        runner.classifying -= events.length;
      }
    })();
  }
  /** The classifier's outcome for one event, or undefined when it does not
   * pass or should no longer be acted on. */
  private async classify(
    runner: Runner,
    agent: Agent,
    classifier: NonNullable<EventWatch["classifier"]>,
    event: RelayEvent,
    live: () => boolean,
  ): Promise<ClassifierOutcome | undefined> {
    // A saved key is not known to be missing until its status is read.
    await this.host.jevStatus();
    const jev = this.host.jev();
    // While the key cannot be read, native is still asked: it may find one.
    if (!jev || this.host.classifierKey() === "missing") return notRun();
    // Only the copy of the app that holds the agent sends its events out.
    if (!(await this.claim(runner)) || !live()) return undefined;
    const context = await this.host.context(agent, event);
    // Stopped or changed while its context was looked up: nothing is sent.
    if (!live()) return undefined;
    const generation = this.host.classifierKeyGeneration();
    const { pass, result } = await classify(jev, {
      classifier,
      event,
      author: {
        role: event.pubkey === agent.owner ? "owner" : "other",
        name: this.host.displayName(agent, event.pubkey),
      },
      context,
    });
    // The key was removed outside the app since it was read, the service
    // refused it, or native found one the failed status read could not.
    if (result.outcome === "not-run")
      this.host.setClassifierKey("missing", generation);
    else if (result.outcome === "passed")
      this.host.setClassifierKey("saved", generation);
    else if (result.reason === "unauthorized")
      this.host.setClassifierKey("refused", generation);
    return pass ? result : undefined;
  }
  /** What `event` wakes in the agent, or "held" while a watch it matches waits
   * for its channel's roster to be confirmed. */
  private heard(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
  ): Trigger[] | "held" {
    const wrote = (id: string) => runner.wrote.has(id);
    // Another of the owner's agents wakes it only by naming it, wherever: were a
    // watch enough, two agents replying to each other would never stop. The
    // claimed owner only narrows this; the type verifies it before answering.
    if (event.tags.some((tag) => tag[0] === "auth" && tag[1] === agent.owner))
      return CHAT_KINDS.includes(event.kind) && tagsAgent(event, agent.pubkey)
        ? [{ type: "mention", event }]
        : [];
    // A one-to-one DM is always addressed to the other member, whoever else it
    // names, so no mention is needed. Only new messages: an edit is not a new
    // turn, and a reaction is not conversation. A group DM still needs the
    // mention.
    if (
      event.kind === 9 &&
      event.pubkey !== agent.pubkey &&
      this.host.dm(agent, event)
    )
      return [{ type: "mention", event }];
    // Addressed events never reach a watch. Only conversation starts a run: not
    // an encrypted DM (kind 4) it cannot read yet, nor a reaction to its message.
    if (addressedTo(event, agent.pubkey, wrote))
      return CHAT_KINDS.includes(event.kind)
        ? [{ type: "mention", event }]
        : [];
    if (!agent.attentionEnabled) return [];
    const matches = this.watches(runner, agent).filter(({ watch, filter }) =>
      watchMatches(watch, event, filter),
    );
    if (!matches.length) return [];
    const member = this.host.member(agent, event);
    if (member === undefined) return "held";
    return member
      ? matches.map(({ filter: _, ...match }) => ({
          type: "watch",
          event,
          ...match,
        }))
      : [];
  }
  /** The job as it should run now, or undefined when it should not run: a
   * watch's event is matched again against the agent's current attention, so
   * one turned off, disabled, removed, replaced or changed since it was
   * queued wakes nothing, even if it now matches again. */
  private current(runner: Runner, agent: Agent, job: Job): Job | undefined {
    const { trigger } = job;
    if (trigger.type !== "watch" && trigger.type !== "catch-up") return job;
    if (!agent.attentionEnabled) return undefined;
    if (
      !job.matched ||
      job.matched.epoch !== runner.epoch ||
      agent.attention[trigger.slug] !== job.matched.object
    )
      return undefined;
    if (trigger.type === "catch-up") {
      const match = this.watches(runner, agent).find(
        ({ slug }) => slug === trigger.slug,
      );
      const events = trigger.events.filter(
        ({ event }) => match && watchMatches(match.watch, event, match.filter),
      );
      if (!match || !events.length) return undefined;
      return {
        ...job,
        trigger: {
          type: "catch-up",
          slug: trigger.slug,
          watch: match.watch,
          ...(match.interest ? { interest: match.interest } : {}),
          events,
          ...(trigger.skipped ? { skipped: true } : {}),
        },
      };
    }
    const match = this.watches(runner, agent).find(
      ({ slug, watch, filter }) =>
        slug === trigger.slug && watchMatches(watch, trigger.event, filter),
    );
    if (!match) return undefined;
    const { filter: _, ...rest } = match;
    return {
      ...job,
      trigger: {
        type: "watch",
        event: trigger.event,
        ...rest,
        ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
      },
    };
  }

  /** Whether `job`, already started, should still run: the rule `current()`
   * applies to a queued job, asked again for work a type queued itself. */
  private stillCurrent(runner: Runner, job: Job) {
    const agent = this.host.agent(runner.pubkey);
    if (!agent) return false;
    const { trigger } = job;
    if (trigger.type === "mention") return true;
    if (trigger.type === "watch" || trigger.type === "catch-up")
      return !!this.current(runner, agent, job);
    // A timer occurrence belongs to the object and epoch it fell due under:
    // attention off and on again, or a disable and rearm, voids it.
    const object = agent.attention[trigger.slug];
    return (
      agent.attentionEnabled &&
      !!job.matched &&
      job.matched.epoch === runner.epoch &&
      object === job.matched.object &&
      object.value.type === "timer" &&
      object.value.enabled
    );
  }

  // Spec schedule rules: occurrence k is due at armed_at + k × interval, at most one
  // runs when overdue, then the next is due interval after it ran. A timer with no
  // saved state counts what was already due as used (see timerState). Checked as a
  // run starts, so no timer has more than one occurrence waiting, and one removed,
  // disabled or expired meanwhile never runs. The longest-waiting timer runs first,
  // so one whose runs outlast its interval cannot hold back the others.
  private dueTimer(runner: Runner, agent: Agent): Job | undefined {
    // Off, timers keep their saved state; one overdue runs once when back on.
    if (!agent.attentionEnabled) return undefined;
    const now = seconds();
    const record = this.host.saved(agent.pubkey) ?? blank(agent.pubkey);
    const prior = record.timers ?? EMPTY;
    let timers = prior;
    let next:
      | {
          slug: string;
          timer: TimerWatch;
          object: AttentionObject;
          state: TimerState;
        }
      | undefined;
    for (const object of Object.values(agent.attention)) {
      const timer = object.value;
      if (timer.type !== "timer" || !timer.enabled) continue;
      const saved = agent.timers[object.slug];
      const state = timerState(timer, saved, now);
      if (state !== saved) timers = { ...timers, [object.slug]: state };
      if (now < state.nextDue || timerSpent(timer, state, now)) continue;
      if (!next || state.nextDue < next.state.nextDue)
        next = { slug: object.slug, timer, object, state };
    }
    const ran = next && {
      ...next.state,
      used: next.state.used + 1,
      nextDue: now + next.timer.interval_secs,
    };
    if (next && ran) timers = { ...timers, [next.slug]: ran };
    if (timers !== prior)
      try {
        this.host.write({ ...record, timers });
      } catch (error) {
        // Unsaved, it would run again at once; it waits for storage instead.
        console.warn(`Agent ${agent.name} timer state was not saved`, error);
        return undefined;
      }
    if (!next || !ran) return undefined;
    const { slug, timer, object } = next;
    const interest = agent.attention[`interest/${timer.interest_id}`]?.value;
    return {
      trigger: {
        type: "timer",
        slug,
        timer,
        ...(interest?.type === "interest" ? { interest } : {}),
        spent: timerSpent(timer, ran, ran.nextDue),
      },
      matched: { object, epoch: runner.epoch },
    };
  }

  private enqueue(runner: Runner, job: Job) {
    const now = Date.now();
    const lane = laneOf(job.trigger);
    const rate = runner.rates[lane];
    const queue = runner.queues[lane];
    if (now - rate.windowStart >= RATE_WINDOW_MS) {
      rate.windowStart = now;
      rate.admitted = 0;
    }
    if (queue.length >= QUEUE_LIMIT || rate.admitted >= RATE_LIMIT) {
      if (runner.activityClaimed) {
        this.showWork(runner, job);
        job.work?.finish({
          ok: false,
          error:
            "Agent is busy and could not queue this request. Try again when it finishes.",
        });
      }
      console.warn(
        `Agent ${this.host.agent(runner.pubkey)?.name} dropped an event`,
      );
      return;
    }
    rate.admitted++;
    if (runner.activityClaimed) this.showWork(runner, job);
    queue.push(job);
    void this.drain(runner);
  }

  private showWork(runner: Runner, job: Job) {
    if (job.work || job.trigger.type !== "mention") return;
    const agent = this.host.agent(runner.pubkey);
    const scope = agent && this.host.scope(agent);
    const event = job.trigger.event;
    const channelId =
      job.channelId ?? event.tags.find(([key]) => key === "h")?.[1];
    if (!scope || !channelId) return;
    job.work = this.host.activity.begin({
      scope,
      agent: runner.pubkey,
      channelId,
      messageId: event.id,
      threadRootId: threadReference(event)?.rootId ?? event.id,
    });
  }

  // One run at a time per agent: mentions in arrival order, then watch work in
  // arrival order, then a due timer.
  // Each job runs the agent as it is when the job starts. While its community's
  // session is not live the queue pauses and update() resumes it; a type that cannot run drops what is queued. A run that ignores
  // its deadline stops holding the queue when the deadline passes; it is not
  // otherwise fenced.
  private async drain(runner: Runner) {
    if (runner.running || runner.transitioning) return;
    runner.running = true;
    while (this.runners.get(runner.pubkey) === runner) {
      const agent = this.host.ready(runner.pubkey);
      const type = runner.type;
      const run = type?.run;
      // An agent this copy cannot run is left to another copy of the app.
      if (!agent || !type || !run) {
        if (agent) {
          this.host.activity.clear(undefined, runner.pubkey);
          runner.queues.mention.length = 0;
          runner.queues.watch.length = 0;
        }
        await this.release(runner);
        // It may have come back into view, or gained its type, meanwhile.
        if (this.host.ready(runner.pubkey) !== agent || runner.type !== type)
          continue;
        break;
      }
      // Every copy of the app on this machine hears the same events; only the
      // one holding the agent runs them. Asked on every wake too, so a copy
      // takes over within a tick of the holder quitting or letting go.
      if (!(await this.claim(runner))) {
        this.host.activity.clear(undefined, runner.pubkey);
        runner.activityClaimed = false;
        runner.queues.mention.length = 0;
        runner.queues.watch.length = 0;
        break;
      }
      // Retype may have reserved this idle runner while claim was pending.
      if (runner.transitioning) break;
      // The agent or its type may have changed meanwhile.
      if (this.host.ready(runner.pubkey) !== agent || runner.type !== type)
        continue;
      runner.activityClaimed = true;
      for (const queued of [...runner.queues.mention, ...runner.queues.watch])
        this.showWork(runner, queued);
      const queued =
        runner.queues.mention.shift() ?? runner.queues.watch.shift();
      const job = queued
        ? this.current(runner, agent, queued)
        : this.dueTimer(runner, agent);
      if (queued && !job) continue;
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
        media: (url: string) => this.require().media(agent.pubkey, url),
        remember: (slug: string, body: string, after: number) =>
          this.require().remember(agent.pubkey, slug, body, after),
        templates: () => this.host.templates(agent),
        attention: this.attention(agent.pubkey),
      });
      const working = this.working(runner, job, agent);
      // A wake is not in its lane until it is handed there below.
      const handing = job.trigger.type !== "mention" && !!type.runOnce;
      if (handing) runner.handing++;
      const completion = Promise.resolve().then(async () => {
        const pick = await pickFor(job.trigger, agent, type);
        const team = this.host.team(agent.pubkey);
        signal.throwIfAborted();
        const delivery = Object.freeze({
          trigger: job.trigger,
          ...(job.channelId ? { channelId: job.channelId } : {}),
          agent: handle,
          config: agent.config,
          ...pick,
          ...(team ? { team } : {}),
          signal,
          workingUntil: working.hold,
          ignored: () => job.work?.remove(),
          acknowledged: () => job.work?.started(),
          superseded: () => job.work?.supersede(),
          step: (tool: string, target?: string) => job.work?.step(tool, target),
          current: () => !lifetime.aborted && this.stillCurrent(runner, job),
        });
        const { trigger } = job;
        const runOnce = type.runOnce?.bind(type);
        if (trigger.type === "mention" || !runOnce) return run(delivery);
        // A watch or timer is a standalone turn in its Interest's lane.
        const { lanes } = runner;
        delivery.workingUntil(
          wake(
            lanes,
            handle,
            trigger,
            () => lanes === runner.lanes && delivery.current(),
            (key, prompt) =>
              standalone(lifetime, (signal) =>
                runOnce({ delivery, key, signal, prompt }),
              ),
            type.title,
          ),
        );
      });
      // Handover expiry releases the queue, never the actual work's outcome.
      void completion.then(
        () => working.release(),
        (error) => working.release({ ok: false, error: message(error) }),
      );
      if (handing)
        void completion
          .catch(() => {})
          .then(() => {
            runner.handing--;
          });
      try {
        await Promise.race([
          completion,
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
      }
    }
    runner.running = false;
  }

  /** Counts a run as working until it and everything it handed to
   * `workingUntil` have settled, however long that takes. A
   * mention run is shown typing in its thread meanwhile, from its first
   * `workingUntil`: a runtime that ignores the mention never shows it. Its
   * activity stays on this device. */
  private working(
    runner: Runner,
    { trigger, channelId, work }: Job,
    agent: Agent,
  ) {
    work?.started();
    const event = trigger.type === "mention" ? trigger.event : undefined;
    const channel =
      event && (channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1]);
    let typing: (() => void) | undefined;
    const beginTyping = () => {
      if (typing || !event || !channel) return;
      typing = pulseTyping(
        // Straight to custody, so pulses stay out of what it wrote.
        async (pulse) => this.require().publish(runner.pubkey, pulse),
        // Where its turn answers, read the same way.
        this.host.meChat(agent, channel, runner.controller.signal),
        event,
        channel,
        runner.typing,
      );
    };
    let holds = 1;
    let outcome: WorkOutcome = { ok: true };
    const lifetime = runner.controller.signal;
    runner.working++;
    const stop = () => {
      if (holds < 0) return;
      holds = -1;
      lifetime.removeEventListener("abort", abort);
      runner.working--;
      typing?.();
    };
    const abort = () => {
      work?.remove();
      stop();
    };
    lifetime.addEventListener("abort", abort, { once: true });
    const release = (result?: unknown) => {
      if (holds <= 0) return;
      if (
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false
      ) {
        outcome = {
          ok: false,
          error:
            "error" in result
              ? String(result.error)
              : "Could not finish this request",
        };
      }
      if (--holds === 0) {
        work?.finish(outcome);
        stop();
      }
    };
    return {
      hold(pending: PromiseLike<unknown>) {
        if (holds <= 0) return;
        holds++;
        beginTyping();
        Promise.resolve(pending).then(release, (error) =>
          release({ ok: false, error: message(error) }),
        );
      },
      release,
    };
  }

  private async claim(runner: Runner) {
    try {
      runner.mayHold = (await this.host.custody?.claim(runner.pubkey)) ?? false;
      runner.asked = true;
      return runner.mayHold;
    } catch (error) {
      runner.mayHold = true;
      runner.asked = true;
      // Answering twice beats not answering at all.
      console.warn(
        `Agent ${this.host.agent(runner.pubkey)?.name} was not claimed`,
        error,
      );
      return true;
    }
  }
  /** Claims exclusively for a provider migration. Unlike turn execution,
   * uncertainty is unsafe here because changing native type is destructive. */
  private async claimForRetype(runner: Runner) {
    runner.mayHold = (await this.host.custody?.claim(runner.pubkey)) ?? false;
    return runner.mayHold;
  }
  private async release(runner: Runner) {
    if (!runner.mayHold) return;
    runner.mayHold = false;
    await this.host.custody
      ?.release(runner.pubkey)
      .catch((error) =>
        console.warn(`Agent ${runner.pubkey} was not released`, error),
      );
  }

  /** The agent's attention as its handle offers it. Reads the saved record
   * each call, so it is current however long the run lasts. */
  private attention(pubkey: string): AgentAttention {
    const record = () => this.host.record(pubkey);
    return Object.freeze({
      enabled: () => record().attentionEnabled === true,
      classifier: () => this.host.classifier(),
      show: (slug: string, interest?: string) =>
        show(record(), slug, seconds(), interest),
      interests: (search?: string) => interestIds(record(), search),
      watches: (filter: WatchFilter = {}) =>
        watchSummaries(record(), filter, seconds()),
      write: async (
        slug: string,
        value: AttentionValue | null,
        options: WriteOptions,
      ) => {
        // The token is checked against the record as it is when the write
        // lands: a write that raced this one makes it check again, a few times.
        for (let attempt = 0; ; attempt++) {
          const before = record();
          const after = await checkedWrite(
            before,
            slug,
            value,
            options,
            seconds(),
          );
          if (record() !== before) {
            if (attempt < 3) continue;
            throw new AttentionError(
              "conflict",
              `${slug} is changing; show it again`,
            );
          }
          this.host.write(after);
          return show(after, slug, seconds());
        }
      },
    });
  }

  private require() {
    if (!this.host.custody)
      throw new Error("Agents run only in the desktop app");
    return this.host.custody;
  }
  private async publish(runner: Runner, event: AgentEventTemplate) {
    const signed = await this.require().publish(runner.pubkey, event);
    bounded(runner.wrote, signed.id);
    return signed;
  }
}

/** Runs a standalone turn with a signal that also aborts
 * STANDALONE_DEADLINE_MS after it starts, so the deadline covers the
 * harness's readiness wait as well as the turn. */
async function standalone<T>(
  lifetime: AbortSignal,
  turn: (signal: AbortSignal) => Promise<T>,
) {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(
          `The turn ran past its ${STANDALONE_DEADLINE_MS / 1000}s deadline and was stopped`,
        ),
      ),
    STANDALONE_DEADLINE_MS,
  );
  try {
    return await turn(AbortSignal.any([lifetime, deadline.signal]));
  } finally {
    clearTimeout(timer);
  }
}
