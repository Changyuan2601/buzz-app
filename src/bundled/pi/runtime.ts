// Turns Agents deliveries into Pi turns. Every Pi agent here runs in the one
// Pi host (pi.ts), each with its own Pi durable storage, where each Buzz
// conversation is one Pi conversation. A delivery becomes a prompt in the
// harness format, submitted to its conversation; one that arrives while Pi
// works steers the run. A watch or timer runs as a standalone turn
// (`runOnce`), in a one-off conversation. Pi acts in Buzz with the in-process
// Buzz tools, signed by the agent's native-held key. The runtime reports a
// turn that fails, and posts the answer of a mention's turn that never used
// `send`.
import { appClient } from "../../buzz-mcp/app-client";
import type { Context } from "../../buzz-mcp/client";
import { content, errorText } from "../../buzz-mcp/rpc";
import {
  type AddedTool,
  callSessionTool,
  sessionTools,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import type { AgentReads } from "../../features/agents/reads";
import type {
  Agent,
  AgentHandle,
  Agents,
  Delivery,
  Models,
  StandaloneTurn,
  TurnResult,
} from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { effortLabel } from "../claude-code/runtime";
import {
  Pi,
  type PiEvent,
  PiStopped,
  type ToolCall,
  type ToolResult,
} from "./pi";
import { DEFAULT_THINKING, PiSetup, runsAt } from "./setup";
import { readTranscript } from "./transcript";

export type Config = Readonly<{
  /** A Pi provider; empty uses the one Pi's settings name. */
  provider: string;
  /** One of the provider's models; empty uses the one Pi's settings name. */
  model: string;
  /** A thinking level the model has; empty uses the one Pi's settings name. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own conversation, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  provider: "",
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
});

const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];

/** Where a mention's turn replies: its thread, or the top of a Me chat. */
type Where = Readonly<{ channel: string; root: string; topLevel: boolean }>;
const replyTags = ({ channel, root, topLevel }: Where) => [
  ["h", channel],
  ...(topLevel ? [] : [["e", root, "", "reply"]]),
];
/** A Buzz thread or channel the agent has a Pi conversation for. */
export type Place = Readonly<{
  key: string;
  conversation: number;
  channelId: string;
  root?: string;
  name?: string;
  /** When the newest message it was shown was sent. */
  at: number;
}>;
/** How a request settled in Pi: answered, unanswered and why, or not yet,
 * because the agent was closed and its run waits to continue. */
type Waited =
  | { status: "done"; answer: number; text: string }
  | { status: "unanswered"; reason?: string; detail?: string }
  | { status: "closed" };
type Receipt = Pick<Delivery, "step" | "acknowledged" | "superseded"> & {
  /** Where its activity shows: a thread, or a Me chat's channel. */
  scope: string;
  /** Where a run's answer for it is posted. */
  where: Where;
  /** Where Pi placed it in a run: its conversation, its entry there, and the
   * conversation's `send` calls then. */
  placed?: Readonly<{ conversation: number; entry: number; sends: number }>;
};

type Entry = {
  config: Config;
  /** The team sections of the latest run. */
  team: string;
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Each conversation's latest posting policy, as in Claude: when its turns
   * were handed over, and when all of them settled. */
  policies: Map<
    string,
    { topLevel: boolean; handed: Promise<unknown>; settled: Promise<unknown> }
  >;
  /** Mentions handed to Pi and not settled, by request. */
  receipts: Map<string, Receipt>;
  /** The request each conversation's activity shows, by its scope. */
  active: Map<number, Map<string, Receipt>>;
  /** `send` calls that succeeded in each conversation. */
  sends: Map<number, number>;
  /** The answer each conversation last posted for a turn without `send`. */
  posted: Map<number, number>;
  /** The agent was removed: its turns wait in its storage. */
  closed: boolean;
};

export class PiRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  /** Each agent's working conversations, as last read, for a stable view. */
  private readonly views = new Map<string, readonly number[]>();

  /** The Pi host every agent of this type runs in, started when needed. */
  private readonly pi: Pi;
  readonly setup: PiSetup;

  constructor(
    private readonly host: Pick<Host, "spawn">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (pubkey: string) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    /** The tools plugins add to every conversation now. */
    private readonly added: () => readonly AddedTool[] = () => [],
  ) {
    this.pi = new Pi(() => this.spawn, {
      tool: (call) => this.tool(call),
      event: (event) => this.event(event),
    });
    this.setup = new PiSetup(this.pi);
  }

  /** Brings the runtime in line with this type's agents. A removed one's
   * storage closes; its unfinished runs continue when it is back. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        entry.closed = true;
        this.agents.delete(pubkey);
        void this.pi.request("close", { agent: pubkey }).catch(() => undefined);
      }
    for (const agent of agents) {
      const entry = this.agents.get(agent.pubkey);
      if (!entry) continue;
      entry.config = config(agent.config);
      entry.name = agent.name;
    }
  }

  /** The models of the agent's provider, with the thinking levels each has.
   * Without a pick, a turn runs the configured model and level. */
  async models(agent: Agent<Config>): Promise<Models> {
    const { provider, model, effort } = config(agent.config);
    const defaults = await this.setup.defaults();
    const id = provider || defaults.provider;
    if (!id) return { current: "", models: [] };
    const listed = await this.setup.models(id);
    const level = effort || defaults.thinking || DEFAULT_THINKING;
    return {
      current:
        model || (id === defaults.provider ? (defaults.model ?? "") : ""),
      models: listed.map((item) => ({
        id: item.id,
        label: item.label,
        efforts: item.thinking.map((id) => ({ id, label: effortLabel(id) })),
        effort: runsAt(item.thinking, level),
      })),
    };
  }

  /** The agent's Buzz conversations, most recently active first. */
  async places(pubkey: string): Promise<Place[]> {
    const { places } = await this.pi.request<{
      places: { key: string; conversation: number; seen: number }[];
    }>("places", { agent: pubkey });
    return places
      .map(({ key, conversation, seen }) => {
        const [channelId = key, root] = key.split("/");
        const name = this.reads(pubkey)?.channelName(channelId);
        return {
          key,
          conversation,
          channelId,
          ...(root ? { root } : {}),
          ...(name ? { name } : {}),
          at: seen * 1000,
        };
      })
      .sort((a, b) => b.at - a.at);
  }
  /** The conversations a Buzz request of the agent's is working in. */
  working(pubkey: string) {
    let view = this.views.get(pubkey);
    if (!view) {
      view = [...(this.agents.get(pubkey)?.active.keys() ?? [])];
      this.views.set(pubkey, view);
    }
    return view;
  }
  transcript(
    pubkey: string,
    place: Place,
    working: boolean,
    signal: AbortSignal,
  ) {
    return readTranscript(this.pi, pubkey, place, working, signal);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }

  dispose() {
    for (const entry of this.agents.values()) entry.closed = true;
    this.agents.clear();
    void this.pi.dispose();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    model,
    effort,
    team,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
  }: Delivery) {
    // Watches and timers come as standalone turns (`runOnce`).
    if (trigger.type !== "mention") return ignored?.();
    // Pi runs commands as you; mentions need owner or delegated authority.
    if (
      !(await fromOwner(
        trigger.event,
        agent.owner,
        workflowOf(this.reads(agent.pubkey), agent.pubkey),
      ))
    )
      return ignored?.();
    signal.throwIfAborted();
    const entry = this.entry(agent, config(raw));
    entry.handle = agent;
    entry.team = team ?? "";
    const { event } = trigger;
    const channel = channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channel) return;
    const topLevel =
      (await this.reads(agent.pubkey)?.meChat(agent.owner, channel, signal)) ??
      false;
    // Frozen with the policy: a scope change while this waits must not move
    // its prompt to another conversation than the one it is delivered to.
    const key = await this.key(entry, agent.pubkey, event, channel, topLevel);
    const root = threadReference(event)?.rootId ?? event.id;
    const where = { channel, root, topLevel };
    // A turn keeps the posting policy it was admitted with: a request under
    // the other policy waits for the conversation's turns to settle rather
    // than steering into them and changing their tools' context.
    const prior = entry.policies.get(key);
    const same = prior?.topLevel === topLevel;
    const wait = prior && (same ? prior.handed : prior.settled);
    const request = event.id;
    let submitted!: { submission: number; conversation: number };
    let sends = 0;
    const handed = (async () => {
      await wait;
      await this.open(agent.pubkey);
      const { seen } = await this.pi.request<{ seen: number }>("place", {
        agent: agent.pubkey,
        key,
      });
      const text = this.review(
        entry,
        turnPrompt({
          ...(await this.turn(
            agent.pubkey,
            event,
            channel,
            key,
            topLevel,
            seen,
          )),
          agent: agent.pubkey,
          label: "@mention",
        }),
      );
      // A conversation's tools default to its thread; a conversation shared
      // by several threads is told which to reply in instead.
      const context: Context = topLevel
        ? { channel, topLevel }
        : key === channel
          ? { channel }
          : { channel, root };
      // Known before Pi has it, as it can say it joined a run first.
      entry.receipts.set(request, {
        scope: topLevel ? channel : root,
        where,
        ...(step ? { step } : {}),
        ...(acknowledged ? { acknowledged } : {}),
        ...(superseded ? { superseded } : {}),
      });
      submitted = await this.pi.request("deliver", {
        agent: agent.pubkey,
        key,
        at: event.created_at,
        context,
        text,
        steer: steerPrompt(text),
        request,
        ...(await this.turnOf(entry, agent.pubkey, model, effort)),
      });
      sends = entry.sends.get(submitted.conversation) ?? 0;
    })();
    const settled = handed
      .then(async (): Promise<TurnResult> => {
        const waited = await this.settle(
          entry,
          agent.pubkey,
          submitted.submission,
        );
        if (waited.status === "done") {
          await this.answer(
            entry,
            agent,
            submitted.conversation,
            { where, sends },
            waited,
          );
          return { ok: true };
        }
        return waited.status === "closed"
          ? { ok: true }
          : { ok: false, error: unanswered(waited) };
      })
      .catch(
        (error: unknown): TurnResult => ({
          ok: false,
          error: errorText(error),
        }),
      )
      .then((result) => {
        this.forget(entry, request);
        // A removed agent's turn continues when it is back.
        return entry.closed ? { ok: true } : result;
      });
    const policy = {
      topLevel,
      handed: handed.catch(() => undefined),
      settled: Promise.all([same ? prior.settled : undefined, settled]).then(
        () => undefined,
      ),
    };
    entry.policies.set(key, policy);
    void policy.settled.then(() => {
      if (entry.policies.get(key) === policy) entry.policies.delete(key);
    });
    // Deliveries keep their order: a later one waits on this handover, and
    // one with nothing to wait for is handed over before `run` returns.
    if (!wait) await policy.handed;
    // The turn outlives `run`, which the host is told so it shows it as working.
    workingUntil(settled);
    void settled.then(async (result) => {
      if (!result.ok) await this.report(agent, where, result.error ?? "");
    });
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * Pi conversation, stopped when `signal` aborts. */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    let stop: (() => void) | undefined;
    try {
      await this.open(agent.pubkey);
      signal.throwIfAborted();
      const text = await prompt();
      if (text === undefined) return { ok: true };
      const turn = await this.turnOf(
        entry,
        agent.pubkey,
        delivery.model,
        delivery.effort,
      );
      signal.throwIfAborted();
      const { submission, conversation } = await this.pi.request<{
        submission: number;
        conversation: number;
      }>("once", {
        agent: agent.pubkey,
        text,
        request: `${key}/${crypto.randomUUID()}`,
        ...turn,
      });
      // A removed agent's storage is closed, and stays so.
      stop = () => {
        if (!entry.closed)
          void this.pi
            .request("abort", { agent: agent.pubkey, conversation })
            .catch(() => undefined);
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const waited = await this.settle(entry, agent.pubkey, submission);
      return waited.status === "unanswered"
        ? { ok: false, error: unanswered(waited) }
        : { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      if (stop) signal.removeEventListener("abort", stop);
    }
  }

  /** Runs a Buzz tool for Pi, for the conversation that called it. */
  async tool(call: ToolCall): Promise<ToolResult> {
    const entry = this.agents.get(call.agent);
    const client =
      entry?.handle &&
      appClient(entry.handle, {
        spawn: this.spawn,
        cwd: entry.config.workspace,
        memories: (slug) => this.memories(call.agent, slug),
        remembered: () => this.forgetMemory(call.agent),
      });
    try {
      const reply = await callSessionTool(
        client,
        call.context,
        call.name,
        call.arguments,
        this.added(),
      );
      const sent = entry && call.name === "send";
      if (sent)
        entry.sends.set(
          call.conversation,
          (entry.sends.get(call.conversation) ?? 0) + 1,
        );
      return {
        content: content(reply),
        ...(sent && call.arguments.final === true ? { final: true } : {}),
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: errorText(error) }],
        isError: true,
      };
    }
  }

  /** What Pi says of its conversations: a request joining a run takes that
   * conversation's activity from the one before it, and steps go to it. */
  event(event: PiEvent) {
    const entry = this.agents.get(event.agent);
    if (!entry) return;
    let active = entry.active.get(event.conversation);
    if (event.type === "placed") {
      const receipt = entry.receipts.get(event.request);
      if (!receipt) return;
      active ??= new Map();
      entry.active.set(event.conversation, active);
      const before = active.get(receipt.scope);
      if (before !== receipt) before?.superseded?.();
      active.set(receipt.scope, receipt);
      receipt.placed ??= {
        conversation: event.conversation,
        entry: event.entry,
        sends: entry.sends.get(event.conversation) ?? 0,
      };
      receipt.acknowledged?.();
      this.notify();
    } else
      for (const receipt of active?.values() ?? [])
        receipt.step?.(event.tool, event.target);
  }

  private forget(entry: Entry, request: string) {
    const receipt = entry.receipts.get(request);
    entry.receipts.delete(request);
    for (const [conversation, active] of entry.active)
      for (const [scope, shown] of active)
        if (shown === receipt) {
          active.delete(scope);
          if (!active.size) entry.active.delete(conversation);
        }
    this.notify();
  }

  /** Opens the agent's storage in the host, with its Buzz tools as they are
   * now. The host does nothing for one already open with these tools. */
  private async open(pubkey: string) {
    await this.pi.request("open", {
      agent: pubkey,
      tools: sessionTools(this.added()),
    });
  }

  /** How a request settles. A host that stopped is started again once: its
   * run continues there, from Pi's storage. */
  private async settle(entry: Entry, pubkey: string, submission: number) {
    for (let attempt = 0; ; attempt++)
      try {
        if (attempt) await this.open(pubkey);
        return await this.pi.request<Waited>("wait", {
          agent: pubkey,
          submission,
        });
      } catch (error) {
        if (attempt || !(error instanceof PiStopped) || entry.closed)
          throw error;
      }
  }

  /** What a turn runs with: the agent's model and thinking level or the
   * owner's pick, its prompt with fresh `core` memory, and its workspace. */
  private async turnOf(
    entry: Entry,
    pubkey: string,
    model?: string,
    effort?: string,
  ) {
    const { workspace, instructions, scope } = entry.config;
    const memory = await this.core(pubkey);
    return {
      provider: entry.config.provider,
      model: entry.config.model,
      thinking: entry.config.effort,
      // Apart, so a request that steers a working run changes only these.
      pick: { model, thinking: effort },
      cwd: workspace,
      instructions: systemPrompt({
        scope,
        cwd: workspace,
        ...(entry.name ? { agent: { name: entry.name, pubkey } } : {}),
        instructions,
        team: entry.team,
        ...(memory === undefined ? {} : { memory }),
      }),
    };
  }

  /** Posts the answer of a run that never sent anything itself, as goose
   * does: once for all the requests it answered, in reply to the latest it
   * took. */
  private async answer(
    entry: Entry,
    agent: AgentHandle,
    conversation: number,
    own: Readonly<{ where: Where; sends: number }>,
    waited: Extract<Waited, { status: "done" }>,
  ) {
    // The latest request Pi placed before the answer, `own` until one is
    // known; one placed after it is another run's. Sends after it was placed
    // answered it; ones before were for earlier requests.
    let latest = { ...own, at: -1 };
    for (const { placed, where } of entry.receipts.values())
      if (
        placed?.conversation === conversation &&
        placed.entry < waited.answer &&
        placed.entry > latest.at
      )
        latest = { where, sends: placed.sends, at: placed.entry };
    const { where, sends } = latest;
    if (
      !waited.text ||
      (entry.sends.get(conversation) ?? 0) !== sends ||
      entry.posted.get(conversation) === waited.answer
    )
      return;
    entry.posted.set(conversation, waited.answer);
    await agent.publish({
      kind: 9,
      content: waited.text,
      tags: replyTags(where),
    });
  }

  /** `text` with the Buzz tools' end-of-turn note, when they have one. */
  private review(entry: Entry, text: string) {
    const note = turnNote(entry.handle);
    return note ? `${text}\n\n${note}` : text;
  }

  /** Says in the thread that a turn failed, so nobody waits on it. Tells the
   * owner even when a sibling asked, as Claude does: tagging the sibling would
   * wake it, and two agents failing alike would wake each other without end. */
  private report(agent: AgentHandle, where: Where, error: string) {
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
        tags: [...replyTags(where), ["p", agent.owner]],
      })
      .catch((failure) =>
        console.warn("Pi could not report a failed turn", failure),
      );
  }

  /** The conversation the event's turn goes to: a Me chat or DM is one
   * conversation, as is a channel for an agent with channel scope. */
  private async key(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = await this.reads(self)?.channel(channelId);
    return topLevel || summary?.dm === true || entry.config.scope === "channel"
      ? channelId
      : `${channelId}/${threadReference(event)?.rootId ?? event.id}`;
  }

  /** What the event's prompt needs: its channel and thread, and the messages
   * before it that the conversation, shown up to `seen`, has not been shown. */
  private async turn(
    self: string,
    event: EventData,
    channelId: string,
    key: string,
    topLevel: boolean,
    seen: number,
  ) {
    const reads = this.reads(self);
    const summary = await reads?.channel(channelId);
    const dm = summary?.dm === true;
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    let earlier: readonly EventData[] = [];
    if (reads && (thread || dm || topLevel))
      try {
        const events = await reads.read(
          thread && !topLevel
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          AbortSignal.timeout(NAMES_TIMEOUT_MS * 2),
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("Pi could not read the conversation", error);
      }
    // A conversation already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) => item.created_at > seen && (!seen || item.pubkey !== self),
    );
    const pubkeys = [
      ...new Set([
        event.pubkey,
        ...unseen.map((item) => item.pubkey),
        ...event.tags
          .filter((tag) => tag[0] === "p")
          .map((tag) => tag[1] ?? ""),
      ]),
    ].filter(Boolean);
    if (reads)
      await Promise.race([
        reads.profiles(pubkeys).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    return {
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(thread ? { thread } : {}),
      context: unseen,
      total: earlier.length + 1,
      name: (pubkey: string) => reads?.name(pubkey, members),
    };
  }

  private entry(agent: AgentHandle, initial: Config): Entry {
    const existing = this.agents.get(agent.pubkey);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      name: agent.name,
      policies: new Map(),
      receipts: new Map(),
      active: new Map(),
      sends: new Map(),
      posted: new Map(),
      closed: false,
    };
    this.agents.set(agent.pubkey, entry);
    return entry;
  }

  private get spawn() {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("Pi agents run only in the desktop app");
    return spawn;
  }

  /** The agent's memory, or only entry `slug`, as its community's reads give
   * it. */
  private memories(pubkey: string, slug?: string) {
    const reads = this.reads(pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forgetMemory(pubkey: string) {
    const reads = this.reads(pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}

/** Why Pi left a request unanswered, in words. */
function unanswered({
  reason,
  detail,
}: Extract<Waited, { status: "unanswered" }>) {
  if (detail) return detail;
  if (reason === "no_model") return "Pi has no model for this agent";
  if (reason === "aborted") return "The turn was stopped";
  return `Pi did not answer (${reason ?? "unknown"})`;
}
