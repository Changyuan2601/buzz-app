// Turns Agents deliveries into turns in each ACP agent's own harness. An
// agent's harness runs the launch its owner confirmed; each conversation is
// one ACP session in it, and a watch or timer wake runs as a one-off session.
// The run returns once the turn is handed over. The harness acts in Buzz with
// the in-process Buzz tools over loopback HTTP MCP, signed by the agent's
// native-held key; the runtime only reports a turn that fails.
// The Buzz side (owner check, conversation context, memory, replies) follows
// the goose runtime's.
import type { Context, Memories } from "../../buzz-mcp/client";
import {
  abortable,
  coreOf,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { respond } from "../../buzz-mcp/rpc";
import { appClient } from "../../buzz-mcp/app-client";
import { turnNote } from "../../buzz-mcp/session-tools";
import { AgentSessions } from "../../features/agent-harness/acp/agent-sessions";
import type {
  ServeMcp,
  Spawn,
  ToolServer,
} from "../../features/agent-harness/acp/types";
import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Delivery,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import { meChat } from "../../features/agents/me-chat";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { sessionTitle, standalonePrompt } from "../goose/runtime";
import { type Config, config } from "./config";
import { HarnessProcess } from "./harness";
import { preset } from "./presets";

/** How long a read of the agent's core memory is reused. */
const MEMORY_TTL_MS = 5 * 60_000;
/** How long a new session waits on its `core` memory. */
const CORE_TIMEOUT_MS = 5_000;
const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];
/** Each thread is its own session. */
const SCOPE: Scope = "thread";
/** No extension picks a model: the launch's args or env do. */
const HARNESS_CHOICE = Object.freeze({ provider: "", model: "" });
const LABEL = "ACP agent";
/** ACP's error code for a harness that needs its user to sign in. */
const AUTH_REQUIRED = -32000;

/** The settings a running harness was started with; a change restarts it. */
const launchOf = ({ command, args, env, workspace, approval }: Config) =>
  JSON.stringify([command, args, env, workspace, approval]);

type Entry = {
  sessions: AgentSessions;
  /** The agent's own harness, running its confirmed launch. */
  harness: HarnessProcess;
  config: Config;
  /** The team sections of the latest run; a change reopens idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename reopens idle sessions. */
  name?: string;
  memory?: { value: string | null | undefined; at: number };
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
};

export class AcpRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly reading = new Map<string, Promise<Memories>>();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
  ) {}

  private get spawn(): Spawn {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("ACP agents run only in the desktop app");
    return spawn;
  }
  private get serve(): ServeMcp {
    const serve = this.host.serveMcp?.bind(this.host);
    if (!serve) throw new Error("ACP agents run only in the desktop app");
    return serve;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * reopen idle sessions, a changed launch restarts the harness, and removed
   * agents stop theirs. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        this.stop(entry);
        this.agents.delete(pubkey);
      }
    for (const agent of agents) {
      const next = config(agent.config);
      const entry = this.agents.get(agent.pubkey);
      if (!entry) this.entry(agent.pubkey, next).name = agent.name;
      else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
        // A harness keeps running what it started with. A new launch retires
        // the agent's sessions, busy ones too, so no later message can queue
        // on the old process while it exits.
        if (launchOf(entry.config) !== launchOf(next)) {
          this.stop(entry);
          const { team, memory, handle, contexts } = entry;
          Object.assign(this.entry(agent.pubkey, next, true), {
            name: agent.name,
            team,
            memory,
            handle,
            contexts,
          });
          continue;
        }
        entry.config = next;
        entry.name = agent.name;
        entry.sessions.reconfigure();
      }
    }
    this.notify();
  }

  /** Conversations each agent has a session for, for its status view. */
  sessions(pubkey: string) {
    let view = this.views.get(pubkey);
    if (!view) {
      view = this.agents.get(pubkey)?.sessions.snapshot() ?? [];
      this.views.set(pubkey, view);
    }
    return view;
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
    for (const entry of this.agents.values()) this.stop(entry);
    this.agents.clear();
  }
  private stop(entry: Entry) {
    entry.sessions.dispose();
    entry.harness.stop();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    team,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
  }: Delivery) {
    const settings = config(raw);
    // Watches and timers come as standalone turns (`runOnce`).
    if (trigger.type !== "mention") return ignored?.();
    // The harness runs commands as you; mentions need owner or delegated
    // authority.
    {
      const snapshot = this.relay(agent.pubkey)?.snapshot();
      if (
        !(await fromOwner(trigger.event, agent.owner, {
          agent: agent.pubkey,
          authority:
            snapshot?.status === "ready"
              ? snapshot.session.workflowAuthority
              : undefined,
          profiles:
            snapshot?.status === "ready"
              ? snapshot.session.profiles
              : undefined,
        }))
      ) {
        ignored?.();
        return;
      }
      signal.throwIfAborted();
    }
    const entry = this.entry(agent.pubkey, settings);
    entry.handle = agent;
    entry.team = team ?? "";
    void this.memory(agent.pubkey, entry);
    const { event } = trigger;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    // Frozen for the turn: its key, prompt, tools and posts all follow it.
    const topLevel = await meChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channel,
      signal,
    );
    // `fresh` is for a session that has been shown nothing yet.
    const prompt = async (fresh: boolean) => {
      const turn = await this.turn(
        entry,
        agent.pubkey,
        event,
        channel,
        topLevel,
        fresh,
      );
      const { channel: where } = turn;
      return {
        key: turn.key,
        place: where.name
          ? `#${where.name}`
          : where.dm
            ? "DM"
            : where.id.slice(0, 8),
        text: this.review(
          entry,
          turnPrompt({ ...turn, agent: agent.pubkey, label: "@mention" }),
        ),
      };
    };
    const { key, text, place } = await prompt(false);
    entry.contexts.set(
      key,
      topLevel
        ? { channel, topLevel }
        : key === channel
          ? { channel }
          : { channel, root: threadReference(event)?.rootId ?? event.id },
    );
    // A new session's first turn is where a harness asks to sign in.
    const first = !entry.sessions.seen(key);
    const done = entry.sessions.deliver(key, text, event.created_at, {
      steer: steerPrompt(text),
      fresh: async () => (await prompt(true)).text,
      title: sessionTitle(entry.name, place, key.split("/")[1]),
      signal,
      activityScope: topLevel
        ? channel
        : (threadReference(event)?.rootId ?? event.id),
      ...(step ? { step } : {}),
      ...(acknowledged ? { acknowledged } : {}),
      ...(superseded ? { superseded } : {}),
    });
    workingUntil(done);
    this.notify();
    void done
      .then((result) => {
        // Of the messages one turn answered, only one has its error or text.
        if (result.error !== undefined) {
          const login =
            first && result.code === AUTH_REQUIRED
              ? preset(entry.config.preset)?.login
              : undefined;
          return this.report(
            agent,
            channel,
            event,
            result.error,
            topLevel,
            login,
          );
        }
        // An answer the harness wrote without `send` is posted for it, so the
        // thread is not left waiting.
        if (result.text)
          return this.post(agent, channel, event, result.text, topLevel);
      })
      .catch((error) => console.warn("ACP agent turn failed", error))
      .finally(() => this.notify());
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * session that joins no conversation. */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent.pubkey, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    void this.memory(agent.pubkey, entry);
    const done = entry.sessions.runOnce(
      key,
      async () => {
        const text = await prompt();
        return text === undefined
          ? undefined
          : standalonePrompt(agent.pubkey, text);
      },
      { signal, title: sessionTitle(entry.name, key) },
    );
    this.notify();
    return done.finally(() => this.notify());
  }

  /** `text` with the Buzz tools' end-of-turn note, when they have one. */
  private review(entry: Entry, text: string) {
    const note = turnNote(entry.handle);
    return note ? `${text}\n\n${note}` : text;
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
    /** What to do about it, kept whole after the shortened error. */
    hint?: string,
  ) {
    const said = error.slice(0, 500);
    return this.post(
      agent,
      channel,
      event,
      `⚠️ I couldn't finish that: ${said}${
        hint ? `${said.endsWith(".") ? "" : "."} ${hint}` : ""
      }`,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Me chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .catch((failure) => console.warn("ACP agent could not post", failure));
  }

  /** Where the event's turn goes, and what its prompt needs. */
  private async turn(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
    fresh = false,
  ) {
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // A Me chat is one conversation, as a DM is.
    const key = topLevel || dm ? channelId : `${channelId}/${rootId}`;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const seen = fresh ? 0 : entry.sessions.seen(key);
    let earlier: readonly EventData[] = [];
    if (session && (thread || dm || topLevel))
      try {
        const events = await session.read(
          thread && !topLevel
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          { signal: AbortSignal.timeout(NAMES_TIMEOUT_MS * 2) },
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
        console.warn("ACP agent could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
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
    if (session)
      await Promise.race([
        session.profiles.ensure(pubkeys, "foreground").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    return {
      key,
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
      name: (pubkey: string) =>
        session?.names.resolve(pubkey, undefined, members) ??
        session?.profiles.snapshot().get(pubkey)?.name ??
        undefined,
    };
  }

  /** The agent's entry, made from `initial` if it has none or `replace`. */
  private entry(pubkey: string, initial: Config, replace = false): Entry {
    const existing = this.agents.get(pubkey);
    if (existing && !replace) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      sessions: undefined as unknown as AgentSessions,
      harness: new HarnessProcess(
        (id, options) => this.spawn(id, options),
        (handler) => this.serve(handler),
        () => entry.config,
      ),
      contexts: new Map(),
    };
    // Every session of the agent shares them, so they read the settings, the
    // handle and the conversation's place as they are when called.
    const tools: ToolServer = async (conversation, message) => {
      const handle = entry.handle;
      const client = handle && {
        ...appClient(handle, {
          spawn: this.spawn,
          cwd: entry.config.workspace,
          memories: (slug) => this.memories(pubkey, slug),
        }),
        remember: async (slug: string, body: string, after: number) => {
          await handle.remember(slug, body, after);
          this.forgetMemories(pubkey);
          if (slug === "core") delete entry.memory;
        },
      };
      const context = (conversation && entry.contexts.get(conversation)) || {};
      return respond(client, context, message);
    };
    entry.sessions = new AgentSessions({
      label: LABEL,
      spawn: (id, options) => this.spawn(id, options),
      tools,
      process: entry.harness,
      onChange: () => this.notify(),
      choice: () => HARNESS_CHOICE,
      fingerprint: () =>
        JSON.stringify([
          launchOf(entry.config),
          entry.config.instructions,
          entry.team,
          entry.name,
        ]),
      launch: async () => {
        const { workspace, instructions } = entry.config;
        const memory = await this.memory(pubkey, entry);
        return {
          workspace,
          systemPrompt: systemPrompt({
            scope: SCOPE,
            cwd: workspace,
            ...(entry.name ? { agent: { name: entry.name, pubkey } } : {}),
            instructions,
            team: entry.team,
            ...(memory === undefined ? {} : { memory }),
          }),
        };
      },
    });
    this.agents.set(pubkey, entry);
    return entry;
  }

  /** The agent's `core` memory, as a new session's prompt carries it: its
   * text, `null` when it has none, or undefined when it could not be read. */
  private async memory(pubkey: string, entry: Entry) {
    if (entry.memory && Date.now() - entry.memory.at < MEMORY_TTL_MS)
      return entry.memory.value;
    let value: string | null | undefined;
    try {
      value = coreOf(await this.memories(pubkey, "core", CORE_TIMEOUT_MS));
    } catch (error) {
      console.warn("ACP agent could not read the agent's memory", error);
    }
    entry.memory = { value, at: Date.now() };
    return value;
  }

  /** The agent's memory, or only entry `slug`, read back through the owner's
   * session: it is encrypted to the owner, so no agent key is needed. */
  private memories(
    pubkey: string,
    slug?: string,
    wait = READ_TIMEOUT_MS,
  ): Promise<Memories> {
    const key = `${pubkey}\0${slug ?? ""}`;
    let reading = this.reading.get(key);
    if (!reading) {
      const started = this.readMemories(pubkey, slug).finally(() => {
        if (this.reading.get(key) === started) this.reading.delete(key);
      });
      this.reading.set(key, started);
      reading = started;
    }
    // The shared read keeps its own bound, so a caller that stops waiting
    // sooner cannot cut it short for the others.
    return abortable(reading, AbortSignal.timeout(wait));
  }
  /** After a memory write, a read that may have started before it is not
   * shared with later callers. */
  private forgetMemories(pubkey: string) {
    for (const key of this.reading.keys())
      if (key.startsWith(`${pubkey}\0`)) this.reading.delete(key);
  }
  private async readMemories(pubkey: string, slug?: string): Promise<Memories> {
    const snapshot = this.relay(pubkey)?.snapshot();
    if (snapshot?.status !== "ready") throw new Error("Buzz is not connected");
    return snapshot.session.agentMemories.read(
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
}
