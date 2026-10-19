import type { ConversationStart } from "./conversation-start";
// The agent runner: one queue per agent, its rate limit, mention and watch
// matching, due timers, the run deadline and the claim that lets exactly one
// host run each agent. It knows nothing of where it runs: everything it needs
// of the device, community and storage comes through its RunnerHost, so the
// desktop app and a standalone host run agents with the same code.
import type {
  Agent,
  AgentAttention,
  AgentHandle,
  ClassifierSkip,
  RegisteredAgentType,
  Trigger,
} from "./service";
import type { LocalAgentActivity, WorkOutcome } from "./local-activity";
import { threadReference } from "../relay/thread-reference";
import type { RelayEvent } from "../relay/events";
import { Lanes } from "../agent-harness/lanes";
import { wake } from "../agent-harness/wakes";
import { STANDALONE_DEADLINE_MS } from "../agent-harness/standalone";
import { EFFORT_TAG, MODEL_TAG } from "../relay/messages";
import type { LiveBatch } from "../relay/incoming";
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
  type WatchFilter,
  type WriteOptions,
} from "./attention-objects";
import type { AgentEventTemplate, AgentIdentity, AgentsNative } from "./native";
import type { AgentRecord } from "./store";
import { type Pulses, pulseTyping } from "./typing";

const QUEUE_LIMIT = 32;
/** The spec asks for at least the agent's 2,048 most recent events. */
const SEEN_LIMIT = 2_048;
/** Runs per agent per minute; bounds two agents that answer each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** Until a classifier is wired in, every classified watch passes unchecked. */
const UNAVAILABLE: ClassifierSkip = Object.freeze({
  outcome: "not-run",
  reason: "no classifier is available on this device",
});

const bounded = (set: Set<string>, id: string) => {
  set.add(id);
  if (set.size > SEEN_LIMIT) set.delete(set.values().next().value as string);
};

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
type StartJob = {
  admitted?(): void;
  type: "conversation-start";
  publicationId?: string;
  channelId: string;
  prompt: string;
  signal: AbortSignal;
  check(): void;
  resolve(event: RelayEvent): void;
  reject(error: unknown): void;
};
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
  queue: (Job | StartJob)[];
  running: boolean;
  windowStart: number;
  admitted: number;
  /** Events seen, and events it wrote (so reactions to them reach no watch). */
  readonly seen: Set<string>;
  readonly wrote: Set<string>;
  /** Turns still counted as working, which a change of type waits out. */
  working: number;
  /** Its typing pulses, one per conversation it is working in. */
  readonly typing: Pulses;
  /** A provider/config transition owns the idle runner and pauses its queue. */
  transitioning: boolean;
  /** Whether native may hold the agent for this copy; true at first, since
   * native outlives a page reload. */
  mayHold: boolean;
  activityClaimed?: boolean;
  /** Advances each time attention is seen off, which voids queued watch work. */
  epoch: number;
  /** Watch and timer turns for a type with `runOnce`, one lane per Interest. */
  lanes: Lanes;
  /** Whether a claim has been answered, so `mayHold` is known rather than
   * assumed. */
  asked?: boolean;
  claimError?: string | undefined;
  compiled?: {
    attention: Agent["attention"];
    watches: readonly CompiledWatch[];
  };
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
  /** The agent as `Agents.find` gives it. */
  find(pubkey: string): Agent | undefined;
  /** Whether the agent is in the event's channel. */
  member(agent: Agent, event: RelayEvent): boolean;
  /** Whether the event's channel is a DM between the agent and one other. */
  dm(agent: Agent, event: RelayEvent): boolean;
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
  proposeInstructions(pubkey: string, text: string, channelId: string): void;
  welcomeGuidance(
    agent: Agent,
    event: RelayEvent,
    channelId: string,
  ): string | undefined;
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
  constructor(private readonly host: RunnerHost) {}

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
        runner.queue = runner.queue.filter(
          (job) => "type" in job || job.trigger.type !== "watch",
        );
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
        runner.queue.length ||
        ready.has(runner.pubkey) !== this.connected.has(runner.pubkey)
      )
        void this.drain(runner);
    this.connected = new Set(ready);
  }
  /** Wakes each runner, which starts any timer that is due. */
  tick() {
    for (const runner of this.runners.values()) void this.drain(runner);
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
  /** A first turn shares the normal queue, native claim, rate limit and lifetime.
   * Its input is never cast to a RelayEvent. */
  startConversation(
    pubkey: string,
    channelId: string,
    prompt: string,
    signal: AbortSignal,
    check: () => void,
    publicationId?: string,
  ) {
    const runner = this.runners.get(pubkey);
    if (
      !runner?.type?.startConversation ||
      runner.transitioning ||
      runner.working
    )
      return Promise.reject(
        new Error("This agent cannot start a conversation right now."),
      );
    return new Promise<RelayEvent>((resolve, reject) => {
      const job: StartJob = {
        type: "conversation-start",
        ...(publicationId ? { publicationId } : {}),
        channelId,
        prompt,
        signal,
        check,
        resolve,
        reject,
      };
      const abort = () => {
        runner.queue = runner.queue.filter((queued) => queued !== job);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      const finish = () => signal.removeEventListener("abort", abort);
      job.admitted = finish;
      job.resolve = (event) => {
        finish();
        resolve(event);
      };
      job.reject = (error) => {
        finish();
        reject(error);
      };
      if (signal.aborted) abort();
      else this.enqueue(runner, job);
    });
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
      queue: [],
      running: false,
      windowStart: 0,
      admitted: 0,
      seen: new Set(),
      wrote: new Set(),
      working: 0,
      typing: new Map(),
      transitioning: false,
      mayHold: true,
      epoch: 0,
      lanes: new Lanes(),
    };
  }
  private retire(runner: Runner) {
    this.host.activity.clear(undefined, runner.pubkey);
    this.dropQueue(runner, "The agent stopped before Welcome started.");
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
        // No classifier model runs here yet, so the event passes unclassified.
        ...(watch.classifier && this.host.classifier() === "unavailable"
          ? { classifier: UNAVAILABLE }
          : {}),
        ...(watch.filter ? { filter: compileFilter(watch.filter) } : {}),
      });
    }
    runner.compiled = { attention: agent.attention, watches };
    return watches;
  }

  /** Gives a community's live events to the agents in it. */
  dispatch(batch: LiveBatch, heard: (agent: Agent) => boolean) {
    for (const runner of this.runners.values()) {
      const agent = this.host.ready(runner.pubkey);
      if (!agent || !heard(agent) || !runner.type?.run) continue;
      for (const event of batch.events) {
        if (runner.seen.has(event.id)) continue;
        bounded(runner.seen, event.id);
        // An agent never hears itself; its own events keep reactions to them
        // from its watches.
        if (event.pubkey === agent.pubkey) {
          bounded(runner.wrote, event.id);
          continue;
        }
        for (const trigger of this.heard(runner, agent, event))
          this.enqueue(runner, {
            trigger,
            ...(batch.channelId ? { channelId: batch.channelId } : {}),
            ...(trigger.type === "watch"
              ? {
                  matched: {
                    object: agent.attention[trigger.slug] as AttentionObject,
                    epoch: runner.epoch,
                  },
                }
              : {}),
          });
      }
    }
  }
  private heard(runner: Runner, agent: Agent, event: RelayEvent): Trigger[] {
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
    if (!agent.attentionEnabled || !this.host.member(agent, event)) return [];
    return this.watches(runner, agent)
      .filter(({ watch, filter }) => watchMatches(watch, event, filter))
      .map(({ filter: _, ...match }) => ({ type: "watch", event, ...match }));
  }
  /** The job as it should run now, or undefined when it should not run: a
   * watch's event is matched again against the agent's current attention, so
   * one turned off, disabled, removed, replaced or changed since it was
   * queued wakes nothing, even if it now matches again. */
  private current(runner: Runner, agent: Agent, job: Job): Job | undefined {
    const { trigger } = job;
    if (trigger.type !== "watch") return job;
    if (!agent.attentionEnabled) return undefined;
    if (
      !job.matched ||
      job.matched.epoch !== runner.epoch ||
      agent.attention[trigger.slug] !== job.matched.object
    )
      return undefined;
    const match = this.watches(runner, agent).find(
      ({ slug, watch, filter }) =>
        slug === trigger.slug && watchMatches(watch, trigger.event, filter),
    );
    if (!match) return undefined;
    const { filter: _, ...rest } = match;
    return {
      ...job,
      trigger: { type: "watch", event: trigger.event, ...rest },
    };
  }

  /** Whether `job`, already started, should still run: the rule `current()`
   * applies to a queued job, asked again for work a type queued itself. */
  private stillCurrent(runner: Runner, job: Job) {
    const agent = this.host.find(runner.pubkey);
    if (!agent) return false;
    const { trigger } = job;
    if (trigger.type === "mention") return true;
    if (trigger.type === "watch") return !!this.current(runner, agent, job);
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

  private enqueue(runner: Runner, job: Job | StartJob) {
    const now = Date.now();
    if (now - runner.windowStart >= RATE_WINDOW_MS) {
      runner.windowStart = now;
      runner.admitted = 0;
    }
    if (runner.queue.length >= QUEUE_LIMIT || runner.admitted >= RATE_LIMIT) {
      if ("type" in job) {
        job.reject(new Error("The agent is busy. Try Welcome again later."));
        return;
      }
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
    runner.admitted++;
    if (runner.activityClaimed) this.showWork(runner, job);
    runner.queue.push(job);
    void this.drain(runner);
  }

  private showWork(runner: Runner, job: Job | StartJob) {
    if ("type" in job) return;
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

  // One run at a time per agent: events in arrival order, then a due timer.
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
          this.dropQueue(runner, "The agent is no longer available.");
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
        this.dropQueue(
          runner,
          `Another copy of Buzz is running ${this.host.agent(runner.pubkey)?.name ?? agent.name}. Continue in that copy, or close it first.`,
        );
        break;
      }
      // Retype may have reserved this idle runner while claim was pending.
      if (runner.transitioning) break;
      // The agent or its type may have changed meanwhile.
      if (this.host.ready(runner.pubkey) !== agent || runner.type !== type)
        continue;
      runner.activityClaimed = true;
      for (const queued of runner.queue) this.showWork(runner, queued);
      const queued = runner.queue.shift();
      if (queued && "type" in queued) {
        queued.admitted?.();
        try {
          queued.resolve(await this.beginConversation(runner, agent, queued));
        } catch (error) {
          queued.reject(error);
        }
        continue;
      }
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
        proposeInstructions: (text: string, channelId: string) => {
          signal.throwIfAborted();
          this.host.proposeInstructions(agent.pubkey, text, channelId);
        },
        attention: this.attention(agent.pubkey),
      });
      const working = this.working(runner, job, agent);
      const completion = Promise.resolve().then(async () => {
        const pick = await pickFor(job.trigger, agent, type);
        const team = this.host.team(agent.pubkey);
        const guidance =
          job.trigger.type === "mention"
            ? this.host.welcomeGuidance(
                agent,
                job.trigger.event,
                job.channelId ??
                  job.trigger.event.tags.find(([key]) => key === "h")?.[1] ??
                  "",
              )
            : undefined;
        signal.throwIfAborted();
        const delivery = Object.freeze({
          trigger: job.trigger,
          ...(job.channelId ? { channelId: job.channelId } : {}),
          agent: handle,
          config: agent.config,
          ...pick,
          ...(team ? { team } : {}),
          ...(guidance ? { guidance } : {}),
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

  private dropQueue(runner: Runner, reason: string) {
    for (const job of runner.queue)
      if ("type" in job) job.reject(new Error(reason));
    runner.queue.length = 0;
  }

  private async beginConversation(runner: Runner, agent: Agent, job: StartJob) {
    const start = runner.type?.startConversation;
    if (runner.claimError)
      throw new Error(
        "Agent hosting could not be confirmed. Retry Welcome after closing other dev builds.",
      );
    if (!start) throw new Error("This provider cannot start Welcome.");
    const lifetime = runner.controller.signal;
    const deadline = AbortSignal.timeout(STANDALONE_DEADLINE_MS);
    const signal = AbortSignal.any([lifetime, job.signal, deadline]);
    let finished = false;
    const check = () => {
      if (finished) throw new Error("Welcome has finished.");
      signal.throwIfAborted();
      job.check();
      if (
        this.host.ready(agent.pubkey)?.type !== agent.type ||
        this.runners.get(agent.pubkey) !== runner
      )
        throw new Error("The agent changed before Welcome could finish.");
    };
    check();
    let reply: RelayEvent | undefined;
    let publication: Promise<RelayEvent> | undefined;
    const unavailable = () => {
      throw new Error(
        "Welcome can only send its introduction in this conversation.",
      );
    };
    const handle: AgentHandle = Object.freeze({
      pubkey: agent.pubkey,
      name: agent.name,
      owner: agent.owner,
      publish: async (event: AgentEventTemplate) => {
        check();
        const channels = event.tags?.filter(([key]) => key === "h") ?? [];
        if (
          event.kind !== 9 ||
          channels.length !== 1 ||
          channels[0]?.length !== 2 ||
          channels[0]?.[1] !== job.channelId ||
          event.tags?.some(([key]) => key === "e")
        )
          return unavailable();
        if (publication)
          throw new Error("Welcome already submitted its introduction.");
        publication = this.publish(
          runner,
          job.publicationId
            ? {
                ...event,
                tags: [
                  ...(event.tags ?? []).filter(([key]) => key !== "client-id"),
                  ["client-id", job.publicationId],
                ],
              }
            : event,
        );
        const signed = await publication;
        reply = signed;
        return signed;
      },
      query: (filters: readonly object[]) => {
        check();
        return this.require().query(agent.pubkey, filters);
      },
      upload: unavailable,
      media: unavailable,
      remember: unavailable,
      templates: () => [],
      proposeInstructions: (text: string, channelId: string) => {
        check();
        this.host.proposeInstructions(agent.pubkey, text, channelId);
      },
      attention: this.attention(agent.pubkey),
    });
    runner.working++;
    try {
      const input: ConversationStart = {
        agent: handle,
        config: agent.config,
        channelId: job.channelId,
        prompt: job.prompt,
        signal,
        check,
      };
      const done = start(input);
      const result = await new Promise<Awaited<typeof done>>(
        (resolve, reject) => {
          const abort = () => {
            // Custody publication cannot be cancelled once entered. Preserve its
            // accepted/unknown outcome instead of pretending navigation unsent it.
            if (publication)
              void publication.then(() => resolve({ ok: true }), reject);
            else reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          void done
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        },
      );
      if (reply) return reply;
      check();
      throw new Error(
        result.error ||
          "The provider finished without publishing an introduction. Retry or send a message yourself.",
      );
    } finally {
      finished = true;
      runner.working--;
    }
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
      runner.claimError = undefined;
      return runner.mayHold;
    } catch (error) {
      runner.claimError = message(error);
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
