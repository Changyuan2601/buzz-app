import { withWelcomeGuidance } from "../../features/agents/onboarding";
import {
  conversationStartPrompt,
  type ConversationStart,
} from "../../features/agents/conversation-start";
// Turns Agents deliveries into goose turns. Every agent of this type shares
// one `goose-acp` process; a delivery becomes a prompt in the harness format,
// sent to the agent's ACP session for its conversation; a watch or timer wake
// runs as a one-off turn in a new session, in its Interest's lane. The run
// returns once the turn is handed over, so one agent works in several
// conversations at once.
// goose acts in Buzz with the in-process Buzz tools over loopback HTTP MCP,
// signed by the agent's native-held key; the runtime only reports a turn that
// fails.
import type { Context } from "../../buzz-mcp/client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { respond } from "../../buzz-mcp/rpc";
import { appClient } from "../../buzz-mcp/app-client";
import {
  type AddedTool,
  addedKey,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Agents,
  type Delivery,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import { ownerReads } from "../../features/agents/reads";
import { soloChat } from "../../features/agents/solo-chat";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
} from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { ownerCanvas, readProject } from "../../features/agent-harness/project";
import type { ServeMcp, ToolServer } from "./goose";
import {
  AgentSessions,
  localSessions,
  ServerPool,
  SharedProcess,
} from "./sessions";

export type Config = Readonly<{
  /** A model the provider offers; empty uses the provider's default, or the
   * goose config's when no provider is named. */
  model: string;
  /** A goose provider; empty uses the goose config's. */
  provider: string;
  /** A thinking level goose offers for the model; empty uses goose's. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  model: "",
  provider: "",
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
const TITLE_LIMIT = 80;

/** A watch's or timer's prompt, after a context naming the agent as a
 * conversation's first prompt does, so its session is listed as the agent's. */
export function standalonePrompt(agent: string, text: string) {
  return `<context>\nScope: standalone\nAgent: ${agent}\n</context>\n\n${text}`;
}

/** A session's title in goose, as harness agents name theirs:
 * `Agent · #channel`, and the thread's root when each thread is a session.
 * A Solo chat's first session keeps it only if goose names no sessions. */
export function sessionTitle(
  agent: string | undefined,
  place: string,
  root?: string,
) {
  const suffix = root ? ` · ${root.slice(0, 8)}` : "";
  const title = `${agent?.trim() || "Buzz agent"} · ${place}`
    .replace(/\s+/g, " ")
    .slice(0, TITLE_LIMIT - suffix.length)
    .trim();
  return `${title}${suffix}`;
}

type Entry = {
  sessions: AgentSessions;
  config: Config;
  /** The team sections of the latest run; a change reopens idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename reopens idle sessions. */
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
};

export class GooseRuntime {
  private readonly agents = new Map<string, Entry>();
  /** The MCP servers every agent's sessions share. */
  private readonly pool = new ServerPool();
  /** The goose every agent's sessions open in. */
  private readonly goose = new SharedProcess(
    {
      spawn: (id, options) => this.desktop.spawn(id, options),
      resolveDirectory: (path) => this.desktop.resolveDirectory(path),
    },
    (handler) => this.serve(handler),
  );
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: Storage = globalThis.localStorage,
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
  ) {}

  /** The desktop host's methods goose agents run with. */
  private get desktop() {
    const { host } = this;
    if (!host.spawn || !host.resolveDirectory || !host.readFile)
      throw new Error("goose agents run only in the desktop app");
    return {
      spawn: host.spawn.bind(host),
      resolveDirectory: host.resolveDirectory.bind(host),
      readFile: host.readFile.bind(host),
    };
  }
  private get serve(): ServeMcp {
    const serve = this.host.serveMcp?.bind(this.host);
    if (!serve) throw new Error("goose agents run only in the desktop app");
    return serve;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * reopen idle sessions, and removed agents stop. goose stops with the
   * last. */
  private defaultsRevision = 0;

  /** Reopen inherited sessions on their next idle turn after Goose defaults save. */
  defaultsChanged() {
    this.defaultsRevision++;
    for (const entry of this.agents.values())
      if (!entry.config.provider.trim()) entry.sessions.reconfigure();
  }

  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        entry.sessions.dispose();
        this.agents.delete(pubkey);
      }
    if (!this.agents.size) this.goose.stop();
    for (const agent of agents) {
      const next = config(agent.config);
      const entry = this.agents.get(agent.pubkey);
      if (!entry) this.entry(agent.pubkey, next).name = agent.name;
      else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
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
  /** The agent's saved conversations, most recently used first. Removing an
   * agent keeps them. */
  conversations(pubkey: string) {
    return localSessions(this.storage, pubkey)
      .list()
      .map(([key, { at }]) => ({ key, at }));
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
  private readonly controls = new SessionControls(() => this.notify());
  private controlKey(agent: Agent, place: SessionPlace) {
    return config(agent.config).scope === "channel" || !place.root
      ? place.channelId
      : `${place.channelId}/${place.root}`;
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
    if (this.controls.compacting(`${agent.pubkey}/${key}`)) return "compacting";
    return this.controls.active(`${agent.pubkey}/${key}`) ||
      this.agents.get(agent.pubkey)?.sessions.active(key)
      ? "active"
      : "idle";
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const key = this.controlKey(agent, place);
    const control = `${agent.pubkey}/${key}`;
    const entry = this.entry(agent.pubkey, config(agent.config));
    if (action === "interrupt") {
      this.controls.interrupt(control);
      await entry.sessions.interrupt(key);
      return;
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (signal) => {
      signal.throwIfAborted();
      const result = await entry.sessions.reset(key, action);
      signal.throwIfAborted();
      if (!result.ok) throw new Error(result.error);
    });
  }

  dispose() {
    for (const entry of this.agents.values()) entry.sessions.dispose();
    this.agents.clear();
    this.goose.stop();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    team,
    model,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
    interruptible,
    guidance,
    named,
  }: Delivery) {
    const settings = config(raw);
    // Watches and timers come as standalone turns (`runOnce`).
    if (trigger.type !== "mention" && trigger.type !== "plugin")
      return ignored?.();
    // A plugin's wake is the owner's installed code, not a message to check.
    const wake = trigger.type === "plugin" ? trigger : undefined;
    // goose runs commands as you; mentions need owner or delegated authority.
    if (trigger.type === "mention") {
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
    const event =
      trigger.type === "plugin" ? wakeAnchor(trigger) : trigger.event;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    // Frozen for the turn: its key, prompt, tools and posts all follow it.
    const topLevel = await soloChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channel,
      signal,
    );
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
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
        text: withWelcomeGuidance(
          turnPrompt({
            ...turn,
            agent: agent.pubkey,
            label: "@mention",
            ...(wake ? { wake } : {}),
          }),
          guidance,
        ),
      };
    };
    const { key, text: prepared, place } = await prompt(false);
    signal.throwIfAborted();
    const handoff = this.controls.deliver(
      `${agent.pubkey}/${key}`,
      async (deferred) => {
        // Accepted deferred work belongs to the captured agent lifetime, not
        // the short deadline for handing a message to the harness.
        if (this.agents.get(agent.pubkey) !== entry) return;
        if (!deferred) signal.throwIfAborted();
        // Plugins' notes wait until the turn is handed over, so one that
        // fails or is cancelled before then leaves them for the next.
        const noteRoot =
          key === channel
            ? undefined
            : (threadReference(event)?.rootId ?? event.id);
        const notes = agent.notes?.(channel, noteRoot) ?? [];
        const text = this.review(entry, prepared, notes);
        entry.contexts.set(
          key,
          topLevel
            ? { channel, topLevel }
            : key === channel
              ? { channel }
              : { channel, root: threadReference(event)?.rootId ?? event.id },
        );
        const done = entry.sessions.deliver(key, text, event.created_at, {
          steer: steerPrompt(text),
          fresh: async () =>
            this.review(entry, (await prompt(true)).text, notes),
          title: sessionTitle(entry.name, place, key.split("/")[1]),
          // A Solo chat takes the name goose gives its first session.
          ...(topLevel && named ? { named } : {}),
          ...(!deferred ? { signal } : {}),
          ...(model ? { model } : {}),
          activityScope: topLevel
            ? channel
            : (threadReference(event)?.rootId ?? event.id),
          ...(step ? { step } : {}),
          ...(acknowledged ? { acknowledged } : {}),
          ...(superseded ? { superseded } : {}),
        });
        workingUntil(done);
        interruptible?.(() => entry.sessions.interrupt(key));
        this.notify();
        void done
          .then((result) => {
            if (result.undelivered)
              agent.restoreNotes?.(channel, notes, noteRoot);
            // Of the messages one turn answered, only one has its error or text.
            if (result.error !== undefined)
              return this.report(agent, channel, event, result.error, topLevel);
            // An answer goose wrote without `send` is posted for it, so the
            // thread is not left waiting.
            if (result.text)
              return this.post(agent, channel, event, result.text, topLevel);
          })
          .catch((error) => console.warn("goose turn failed", error))
          .finally(() => this.notify());
      },
    );
    if (!handoff.deferred) return handoff.done;
    workingUntil(handoff.done);
    void handoff.done
      .catch((error) =>
        this.report(agent, channel, event, String(error), topLevel),
      )
      .catch((error) => console.warn("goose handover failed", error));
  }

  /** App input continues in the same channel session as subsequent Solo messages. */
  async startConversation(input: ConversationStart): Promise<TurnResult> {
    input.check();
    const { agent, channelId, signal } = input;
    const personal = await soloChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channelId,
      signal,
    );
    const snapshot = this.relay(agent.pubkey)?.snapshot();
    const channel =
      snapshot?.status === "ready"
        ? snapshot.session.channels
            .list()
            .channels.find((item) => item.id === channelId)
        : undefined;
    input.check();
    if (
      !personal ||
      channel?.members?.length !== 2 ||
      !channel.members.includes(agent.owner) ||
      !channel.members.includes(agent.pubkey)
    )
      throw new Error(
        "Welcome is no longer a conversation with just you and your agent.",
      );
    const entry = this.entry(agent.pubkey, config(input.config));
    if (entry.sessions.snapshot().some((session) => session.busy))
      throw new Error(
        "The agent is already answering. Retry Welcome when it finishes.",
      );
    entry.handle = agent;
    entry.name = agent.name;
    entry.contexts.set(channelId, { channel: channelId, topLevel: true });
    const abort = () => entry.sessions.stop(channelId);
    signal.addEventListener("abort", abort, { once: true });
    try {
      input.check();
      const result = await entry.sessions.deliver(
        channelId,
        this.review(
          entry,
          conversationStartPrompt(agent.pubkey, channelId, input.prompt),
        ),
        0,
        { title: sessionTitle(agent.name, channel?.name ?? "Welcome") },
      );
      // Like normal Goose turns, an actual model answer without send is published
      // through the same restricted handle, never replaced with prepared UI text.
      if (result.ok && result.text) {
        input.check();
        await agent.publish({
          kind: 9,
          content: result.text,
          tags: [["h", channelId]],
        });
      }
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      this.notify();
    }
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

  /** `text` with the notes plugins left for the turn and the Buzz tools'
   * end-of-turn note, when there are any. */
  private review(entry: Entry, text: string, notes: readonly string[] = []) {
    return [text, ...notes, turnNote(entry.handle)]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
  ) {
    return this.post(
      agent,
      channel,
      event,
      `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Solo chat's top
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
      .catch((failure) => console.warn("goose could not post", failure));
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
    // A Solo chat is one conversation, as a DM is.
    const key =
      topLevel || dm || entry.config.scope === "channel"
        ? channelId
        : `${channelId}/${rootId}`;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const seen = fresh ? 0 : entry.sessions.seen(key);
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const owner = entry.handle?.owner;
    const reading = topLevel
      ? readProject(
          session && owner
            ? () =>
                ownerCanvas(
                  session.canvas,
                  owner,
                  channelId,
                  session.channelWrites.startingCanvas(channelId),
                )
            : undefined,
        )
      : Promise.resolve(undefined);
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
        console.warn("goose could not read the conversation", error);
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
    const project = (await reading)?.section;
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
      ...(project ? { project } : {}),
    };
  }

  private entry(pubkey: string, initial: Config): Entry {
    const existing = this.agents.get(pubkey);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
    };
    // Every session of the agent shares them, so they read the settings, the
    // handle and the conversation's place as they are when called.
    const tools: ToolServer = async (conversation, message) => {
      const handle = entry.handle;
      const client =
        handle &&
        appClient(handle, {
          relayAuthor: this.relay(pubkey)?.snapshot().session.relayAuthor,
          audienceAuthorityCommunity:
            this.relay(pubkey)?.snapshot().session.audienceAuthorityCommunity,
          signingAuthority:
            this.relay(pubkey)?.snapshot().session.workflowAuthority,
          read: async (path) =>
            this.desktop.readFile(path, { cwd: entry.config.workspace }),
          memories: (slug) => this.memories(pubkey, slug),
          remembered: () => this.forget(pubkey),
        });
      const context = (conversation && entry.contexts.get(conversation)) || {};
      return respond(client, context, message, this.added());
    };
    entry.sessions = new AgentSessions({
      resolveDirectory: (path) => this.desktop.resolveDirectory(path),
      tools,
      process: this.goose,
      pool: this.pool,
      store: localSessions(this.storage, pubkey),
      onChange: () => this.notify(),
      // Read as each turn starts, so a change needs no restart.
      choice: () => ({
        provider: entry.config.provider.trim(),
        model: entry.config.model.trim(),
        effort: entry.config.effort,
      }),
      fingerprint: () =>
        JSON.stringify([
          entry.config.provider.trim() ? 0 : this.defaultsRevision,
          entry.config.workspace,
          entry.config.instructions,
          entry.config.scope,
          entry.team,
          entry.name,
          addedKey(this.added()),
        ]),
      launch: async () => {
        const { workspace, instructions, scope } = entry.config;
        const memory = await this.core(pubkey);
        return {
          workspace,
          systemPrompt: systemPrompt({
            scope,
            cwd: workspace,
            repositories: this.repositories(
              this.relay(pubkey)?.snapshot().scope,
            ),
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

  /** The agent's memory, or only entry `slug`, as the owner's reads of its
   * community give it: it is encrypted to the owner, so no agent key is
   * needed. */
  private memories(pubkey: string, slug?: string) {
    const reads = ownerReads(this.relay(pubkey), pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forget(pubkey: string) {
    const reads = ownerReads(this.relay(pubkey), pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}
