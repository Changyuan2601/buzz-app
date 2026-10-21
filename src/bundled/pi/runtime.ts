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
  sessionHint,
  sessionTools,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { readProject } from "../../features/agent-harness/project";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import type { AgentReads } from "../../features/agents/reads";
import type {
  Agent,
  AgentHandle,
  Agents,
  AgentSession,
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
import { readUsage } from "./usage";

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
/** How long an adopted run's mention is looked for. */
const READ_MS = 10_000;
const CHAT = [9, 40002];

/** Where a mention's turn replies: its thread, or the top of a Solo chat. */
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
  /** Where its activity shows: a thread, or a Solo chat's channel. */
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
  /** Standalone turns handed to Pi and not settled, by request. */
  standalone: Set<string>;
  /** The request each conversation's activity shows, by its scope. */
  active: Map<number, Map<string, Receipt>>;
  /** `send` calls that succeeded in each conversation. */
  sends: Map<number, number>;
  /** The answer each conversation last posted for a turn without `send`. */
  posted: Map<number, number>;
  /** Runs a stopped app left in Pi's storage, waited for once. */
  adopted?: Promise<void>;
  /** The agent was removed: its turns wait in its storage. */
  closed: boolean;
};

export class PiRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  /** Each agent's working conversations, as last read, for a stable view. */
  private readonly views = new Map<string, readonly number[]>();
  /** The agents of this type that run here now. */
  private running = new Set<string>();
  /** Each agent's conversations as Pi's storage and this app run's
   * deliveries know them, by key; read from storage once, when first asked. */
  private readonly known = new Map<
    string,
    Map<string, { conversation: number; at: number }>
  >();

  /** The Pi host every agent of this type runs in, started when needed. */
  private readonly pi: Pi;
  readonly setup: PiSetup;

  constructor(
    private readonly host: Pick<Host, "spawn" | "readFile">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (pubkey: string) => AgentReads | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    /** The tools plugins add to every conversation now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
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
    // Its storage may be open for a turn or only for listing its sessions.
    for (const pubkey of new Set([...this.running, ...this.agents.keys()]))
      if (!current.has(pubkey)) {
        const entry = this.agents.get(pubkey);
        if (entry) entry.closed = true;
        this.agents.delete(pubkey);
        void this.pi.request("close", { agent: pubkey }).catch(() => undefined);
      }
    this.running = current;
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
    if (!this.known.has(pubkey)) this.known.set(pubkey, new Map());
    let changed = false;
    for (const { key, conversation, seen } of places)
      changed = this.remember(pubkey, key, conversation, seen) || changed;
    if (changed) this.notify();
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
  /** The agent's conversations, most recently active first, with whether
   * each is working while it runs here. The first call reads them from Pi's
   * storage, and tells subscribers when they are in. */
  sessions(pubkey: string): AgentSession[] {
    const known = this.known.get(pubkey);
    // Reading opens its storage, which only an agent running here may hold.
    if (!known && !this.running.has(pubkey)) return [];
    if (!known) {
      this.known.set(pubkey, new Map());
      // One that failed is read again when next asked.
      void this.places(pubkey).catch((error) => {
        if (!this.known.get(pubkey)?.size) this.known.delete(pubkey);
        console.warn("Pi could not list an agent's conversations", error);
      });
      return [];
    }
    const entry = this.agents.get(pubkey);
    return [...known]
      .sort(([, a], [, b]) => b.at - a.at)
      .map(([key, { conversation, at }]) => {
        const [channelId = key, root] = key.split("/");
        return {
          channelId,
          ...(root && { root }),
          at,
          ...(entry && {
            status: entry.active.has(conversation) ? "Working" : "Idle",
          }),
        };
      });
  }
  /** The usage of the agent's Buzz conversations since `since`. */
  async usage(pubkey: string, since: number, signal: AbortSignal) {
    // Reading opens its storage, which only an agent running here may hold.
    if (!this.running.has(pubkey)) return [];
    return readUsage(this.pi, pubkey, await this.places(pubkey), since, signal);
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
    interruptible,
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
      (await this.reads(agent.pubkey)?.soloChat(
        agent.owner,
        channel,
        signal,
      )) ?? false;
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
      this.live(entry, agent.pubkey);
      await this.open(agent.pubkey);
      entry.adopted ??= this.adopt(entry, agent.pubkey, request);
      await entry.adopted;
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
      const picked = await this.turnOf(entry, agent.pubkey, model, effort);
      this.live(entry, agent.pubkey);
      submitted = await this.deliver(entry, agent.pubkey, {
        agent: agent.pubkey,
        key,
        at: event.created_at,
        context,
        text,
        steer: steerPrompt(text),
        request,
        ...picked,
      });
      sends = entry.sends.get(submitted.conversation) ?? 0;
      if (
        this.remember(
          agent.pubkey,
          key,
          submitted.conversation,
          event.created_at,
        )
      )
        this.notify();
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
        // A turn the owner stopped, or a removed agent's, says nothing more.
        return waited.status === "closed" || waited.reason === "aborted"
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
      settled: Promise.all([same ? prior?.settled : undefined, settled]).then(
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
    // Stop on its activity stops the run the request is in.
    interruptible?.(async () => {
      await handed;
      await this.pi.request("abort", {
        agent: agent.pubkey,
        conversation: submitted.conversation,
      });
    });
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
    let request: string | undefined;
    try {
      await this.open(agent.pubkey);
      entry.adopted ??= this.adopt(entry, agent.pubkey);
      await entry.adopted;
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
      request = `${key}/${crypto.randomUUID()}`;
      entry.standalone.add(request);
      const { submission, conversation } = await this.pi.request<{
        submission: number;
        conversation: number;
      }>("once", { agent: agent.pubkey, text, request, ...turn });
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
      if (request) entry.standalone.delete(request);
    }
  }

  /** Runs a Buzz tool for Pi, for the conversation that called it. */
  async tool(call: ToolCall): Promise<ToolResult> {
    const entry = this.agents.get(call.agent);
    const client =
      entry?.handle &&
      appClient(entry.handle, {
        relayAuthor: this.reads(call.agent)?.relayAuthor?.(),
        audienceAuthorityCommunity: this.reads(
          call.agent,
        )?.audienceAuthorityCommunity?.(),
        signingAuthority: this.reads(call.agent)?.workflowAuthority(),
        read: (path) => this.readFile(path, { cwd: entry.config.workspace }),
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

  /** Notes a conversation's newest message, `seen` in seconds, once the
   * agent's conversations were asked for; a later one already known stays.
   * True when that changed what is known. */
  private remember(
    pubkey: string,
    key: string,
    conversation: number,
    seen: number,
  ) {
    const known = this.known.get(pubkey);
    const before = known?.get(key);
    const at = Math.max(seen * 1000, before?.at ?? 0);
    if (!known || (before?.conversation === conversation && before.at === at))
      return false;
    known.set(key, { conversation, at });
    return true;
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
   * now: those loaded on search are deferred until Pi's tool search loads
   * them, and the hint says what to search for. The host does nothing for one
   * already open with these tools. */
  /** Throws for a removed agent, whose queued mention Pi must not run:
   * Pi's coding tools have no sandbox. Its storage, opened again by the
   * handover, closes. */
  private live(entry: Entry, pubkey: string) {
    if (!entry.closed) return;
    if (!this.running.has(pubkey) && !this.agents.has(pubkey))
      void this.pi.request("close", { agent: pubkey }).catch(() => undefined);
    throw new Error("The agent was removed");
  }

  /** Hands a turn to Pi. A host that stops before it answers may have taken
   * the turn already; the next one, asked again, finds it by its request
   * rather than taking it twice. */
  private async deliver(
    entry: Entry,
    pubkey: string,
    params: object,
  ): Promise<{ submission: number; conversation: number }> {
    try {
      return await this.pi.request("deliver", params);
    } catch (error) {
      if (!(error instanceof PiStopped) || entry.closed) throw error;
      await this.open(pubkey);
      this.live(entry, pubkey);
      return this.pi.request("deliver", params);
    }
  }

  /** Takes on the runs an earlier app left unfinished in Pi's storage, which
   * any delivery continues, in whatever thread: they show as working, and
   * their answers are posted and failures reported as a delivery's are, but
   * Stop is not restored. Standalone turns' runs are ended instead. `current`
   * is the request being delivered, which its own run waits for. */
  private async adopt(entry: Entry, pubkey: string, current?: string) {
    let unfinished: readonly {
      submission: number;
      conversation: number;
      request: string;
      context?: { channel: string; root?: string; topLevel?: boolean };
    }[];
    try {
      ({ submissions: unfinished } = await this.pi.request<{
        submissions: typeof unfinished;
      }>("unfinished", { agent: pubkey }));
    } catch (error) {
      // Listed again at the next delivery.
      delete entry.adopted;
      console.warn("Pi could not list an agent's unfinished runs", error);
      return;
    }
    const waits: (() => Promise<void>)[] = [];
    const dropped: { submission: number; conversation: number }[] = [];
    for (const { submission, conversation, request, context } of unfinished) {
      const { handle } = entry;
      if (
        !handle ||
        request === current ||
        entry.receipts.has(request) ||
        entry.standalone.has(request)
      )
        continue;
      // A watch's or timer's run ends with the app, as other harnesses' do:
      // continued, it would have no deadline, lane or Stop.
      if (!context) {
        dropped.push({ submission, conversation });
        continue;
      }
      // A conversation several threads share has no root: its answer goes to
      // the thread of the mention, whose id is the request.
      const root =
        context.root ??
        (context.topLevel ? request : await this.threadOf(pubkey, request));
      const where = {
        channel: context.channel,
        root,
        topLevel: !!context.topLevel,
      };
      const receipt: Receipt = {
        scope: context.topLevel ? context.channel : root,
        where,
      };
      // A delivery of the same request takes it over, and says how it ended.
      const ours = () => entry.receipts.get(request) === receipt;
      entry.receipts.set(request, receipt);
      const active = entry.active.get(conversation) ?? new Map();
      active.set(receipt.scope, receipt);
      entry.active.set(conversation, active);
      const sends = entry.sends.get(conversation) ?? 0;
      waits.push(() =>
        this.settle(entry, pubkey, submission)
          .then(async (waited) => {
            if (!ours()) return;
            if (waited.status === "done")
              await this.answer(
                entry,
                handle,
                conversation,
                { where, sends },
                waited,
              );
            else if (
              waited.status === "unanswered" &&
              waited.reason !== "aborted"
            )
              await this.report(handle, where, unanswered(waited));
          })
          .catch(async (error: unknown) => {
            if (ours() && !entry.closed)
              await this.report(handle, where, errorText(error));
          })
          .finally(() => {
            if (ours()) this.forget(entry, request);
          }),
      );
    }
    // Only once every run's sends are counted: a wait continues all of them,
    // and one could send while a later run's thread is still looked up.
    // Ending the others continues none.
    if (dropped.length)
      await this.pi
        .request("drop", { agent: pubkey, submissions: dropped })
        .catch((error: unknown) =>
          console.warn("Pi could not end left standalone turns", error),
        );
    for (const wait of waits) void wait();
    this.notify();
  }

  /** The thread a mention is in, or opens; itself when it cannot be read. */
  private async threadOf(pubkey: string, id: string) {
    try {
      const [event] =
        (await this.reads(pubkey)?.read(
          [{ ids: [id], limit: 1 }],
          AbortSignal.timeout(READ_MS),
        )) ?? [];
      return (event && threadReference(event)?.rootId) ?? id;
    } catch {
      return id;
    }
  }

  private async open(pubkey: string) {
    await this.pi.request("open", {
      agent: pubkey,
      tools: sessionTools(this.added()),
      hint: sessionHint(this.added()),
    });
  }

  /** How a request settles. A host that stopped, or an agent whose storage
   * failed, is opened again once: its run continues there, from Pi's
   * storage. */
  private async settle(
    entry: Entry,
    pubkey: string,
    submission: number,
  ): Promise<Waited> {
    for (let attempt = 0; ; attempt++) {
      let waited: Waited | { status: "reopen" };
      try {
        if (attempt) await this.open(pubkey);
        waited = await this.pi.request("wait", { agent: pubkey, submission });
      } catch (error) {
        if (attempt || !(error instanceof PiStopped) || entry.closed)
          throw error;
        continue;
      }
      if (waited.status !== "reopen") return waited;
      if (attempt || entry.closed)
        throw new Error("Pi's storage for this agent keeps failing");
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
        repositories: this.repositories(this.reads(pubkey)?.scope),
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

  /** The conversation the event's turn goes to: a Solo chat or DM is one
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
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const canvas = reads?.canvas?.bind(reads);
    const owner = this.agents.get(self)?.handle?.owner;
    const reading = topLevel
      ? readProject(
          canvas && owner ? () => canvas(channelId, owner) : undefined,
        )
      : Promise.resolve(undefined);
    let earlier: readonly EventData[] = [];
    // A chat its owner is still creating has nothing earlier to read.
    if (reads && !summary?.starting && (thread || dm || topLevel))
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
    const project = (await reading)?.section;
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
      ...(project ? { project } : {}),
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
      standalone: new Set(),
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

  private get readFile() {
    const readFile = this.host.readFile?.bind(this.host);
    if (!readFile) throw new Error("Pi agents run only in the desktop app");
    return readFile;
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
