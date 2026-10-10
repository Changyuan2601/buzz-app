// Turns Agents2 deliveries into Claude turns. Each agent of this type has its
// own sessions; a delivery becomes a prompt in the harness format, sent to the
// session for its conversation. The run returns once the turn is handed over,
// so one agent works in several conversations at once. Claude acts in Buzz with
// the in-process Buzz tools, signed by the agent's native-held key; the runtime
// only reports a turn that fails.
import type { Context, Memory } from "../../buzz-mcp/client";
import { respond } from "../../buzz-mcp/rpc";
import type {
  Agent,
  AgentHandle,
  Delivery,
} from "../../features/agents2/service";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import type { Spawn, ToolServer } from "./claude";
import { appClient } from "../../buzz-mcp/app-client";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  timerPrompt,
  turnPrompt,
} from "./prompt";
import { AgentSessions, localSessions, Spare } from "./sessions";

export type Config = Readonly<{
  /** A Claude model or alias; empty uses Claude Code's own default. */
  model: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
  /** Whose messages it acts on. Claude runs commands as you, so by default
   * only yours, as harness agents do. */
  respondTo: "owner" | "anyone";
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  model: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
  respondTo: "owner",
});
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
});

/** How long a read of the agent's core memory is reused. */
const MEMORY_TTL_MS = 5 * 60_000;
const MEMORY_TIMEOUT_MS = 5_000;
const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];

type Entry = {
  sessions: AgentSessions;
  config: Config;
  memory?: { value: string | null | undefined; at: number };
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
};

/** Where an agent's processes run, and with which model. */
const where = ({ workspace, model }: Config) => ({
  cwd: workspace,
  ...(model.trim() ? { model: model.trim() } : {}),
});

export class ClaudeRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly reading = new Map<string, Promise<readonly Memory[]>>();
  private readonly listeners = new Set<() => void>();
  /** Each agent's last session list, kept until something changes so a view
   * reading it gets the same array back. */
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();
  /** One process started ahead of need, for any agent's next new conversation. */
  private readonly spare = new Spare(
    (id, options) => this.spawn(id, options),
    (_conversation, message) => respond(undefined, {}, message),
  );

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
    private readonly storage: Storage = globalThis.localStorage,
  ) {}

  private get spawn(): Spawn {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn)
      throw new Error("Claude Code agents run only in the desktop app");
    return spawn;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * restart idle sessions, removed agents stop, and a spare waits while any
   * agent is here. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    // Deleted, signed out or its community disconnected: either way its
    // processes stop. Saved sessions stay so it resumes when it is back.
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        entry.sessions.dispose();
        this.agents.delete(pubkey);
      }
    for (const agent of agents) {
      const next = config(agent.config);
      const entry = this.agents.get(agent.pubkey);
      if (!entry) this.entry(agent.pubkey, next);
      else if (JSON.stringify(entry.config) !== JSON.stringify(next)) {
        entry.config = next;
        entry.sessions.reconfigure();
      }
    }
    if (agents.length)
      this.spare.warm(...agents.map((agent) => where(config(agent.config))));
    else this.spare.stop();
    this.notify();
  }

  /** Conversations each agent has running, for its status view. */
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
    this.spare.dispose();
    for (const entry of this.agents.values()) entry.sessions.dispose();
    this.agents.clear();
  }

  async run({ trigger, agent, config: raw, channelId }: Delivery) {
    const settings = config(raw);
    if (
      trigger.type !== "timer" &&
      settings.respondTo !== "anyone" &&
      trigger.event.pubkey !== agent.owner
    )
      return;
    const entry = this.entry(agent.pubkey, settings);
    entry.handle = agent;
    // Read while the turn's prompt is built, not after: a new session's prompt
    // needs it, and a spare is only faster if nothing else is awaited.
    void this.memory(agent.pubkey, entry);
    if (trigger.type === "timer") {
      const done = entry.sessions.deliver(
        `timer/${trigger.slug}`,
        timerPrompt({
          slug: trigger.slug,
          prompt: trigger.timer.prompt,
          ...(trigger.interest
            ? { instructions: trigger.interest.instructions }
            : {}),
        }),
        0,
      );
      this.watch(done, () => undefined);
      return;
    }
    const { event } = trigger;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const label = trigger.type === "watch" ? "watch" : "@mention";
    const interest =
      trigger.type === "watch" && trigger.interest
        ? { interest: trigger.interest.instructions }
        : {};
    // `fresh` is for a session that has been shown nothing yet.
    const prompt = async (fresh: boolean) => {
      const turn = await this.turn(entry, agent.pubkey, event, channel, fresh);
      return {
        key: turn.key,
        text: turnPrompt({ ...turn, label, ...interest }),
      };
    };
    const { key, text } = await prompt(false);
    // A conversation's tools default to its thread; a session shared by
    // several threads is told which to reply in instead.
    entry.contexts.set(
      key,
      key === channel
        ? { channel }
        : { channel, root: threadReference(event)?.rootId ?? event.id },
    );
    const done = entry.sessions.deliver(key, text, event.created_at, {
      steer: steerPrompt(text),
      fresh: async () => (await prompt(true)).text,
    });
    this.notify();
    this.watch(done, async (error) => {
      if (error) await this.report(agent, channel, event, error);
    });
  }

  private watch(
    done: Promise<{ ok: boolean; error?: string }>,
    after: (error?: string) => unknown,
  ) {
    void done
      .then((result) => after(result.ok ? undefined : result.error))
      .catch((error) => console.warn("Claude Code turn failed", error))
      .finally(() => this.notify());
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
  ) {
    const root = threadReference(event)?.rootId ?? event.id;
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
        tags: [
          ["h", channel],
          ...(root === event.id ? [] : [["e", root, "", "root"]]),
          ["e", event.id, "", "reply"],
          ["p", event.pubkey],
        ],
      })
      .catch((failure) =>
        console.warn("Claude Code could not report a failed turn", failure),
      );
  }

  /** Where the event's turn goes, and what its prompt needs. */
  private async turn(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
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
    const scope = entry.config.scope;
    const key =
      dm || scope === "channel" ? channelId : `${channelId}/${rootId}`;
    const seen = fresh ? 0 : entry.sessions.seen(key);
    let earlier: readonly EventData[] = [];
    if (session && (thread || dm))
      try {
        const events = await session.read(
          thread
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
        console.warn("Claude Code could not read the conversation", error);
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

  private entry(pubkey: string, initial: Config): Entry {
    const existing = this.agents.get(pubkey);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
    };
    // Each process reads files where it was started, until it is replaced.
    const tools =
      (cwd: string): ToolServer =>
      async (conversation, message) => {
        const handle = entry.handle;
        const client = handle && {
          ...appClient(handle, {
            spawn: this.spawn,
            cwd,
            memories: () => this.memories(pubkey),
          }),
          remember: async (slug: string, body: string, after: number) => {
            await handle.remember(slug, body, after);
            if (slug === "core") delete entry.memory;
          },
        };
        const context =
          (conversation && entry.contexts.get(conversation)) || {};
        return respond(client, context, message);
      };
    entry.sessions = new AgentSessions({
      spawn: (id, options) => this.spawn(id, options),
      spare: this.spare,
      store: localSessions(this.storage, pubkey),
      onChange: () => this.notify(),
      fingerprint: () =>
        JSON.stringify([
          entry.config.model,
          entry.config.workspace,
          entry.config.instructions,
          entry.config.scope,
        ]),
      launch: async () => {
        const { workspace, instructions, scope } = entry.config;
        const memory = await this.memory(pubkey, entry);
        return {
          ...where(entry.config),
          tools: tools(workspace),
          systemPrompt: systemPrompt({
            scope,
            cwd: workspace,
            instructions,
            ...(memory === undefined ? {} : { memory }),
          }),
        };
      },
    });
    this.agents.set(pubkey, entry);
    return entry;
  }

  /** The agent's `core` memory, as the harness injects it into a new session:
   * its text, `null` when it has none, or undefined when it could not be read. */
  private async memory(pubkey: string, entry: Entry) {
    if (entry.memory && Date.now() - entry.memory.at < MEMORY_TTL_MS)
      return entry.memory.value;
    let value: string | null | undefined;
    try {
      const memories = await this.memories(pubkey);
      value = memories.find((memory) => memory.slug === "core")?.body ?? null;
    } catch (error) {
      console.warn("Claude Code could not read the agent's memory", error);
    }
    entry.memory = { value, at: Date.now() };
    return value;
  }

  /** The agent's memory, read back through the owner's session: it is
   * encrypted to the owner, so no agent key is needed to read it. */
  private memories(pubkey: string): Promise<readonly Memory[]> {
    // The owner's session holds few memory views at once, so calls share one.
    let reading = this.reading.get(pubkey);
    if (!reading) {
      reading = this.readMemories(pubkey).finally(() =>
        this.reading.delete(pubkey),
      );
      this.reading.set(pubkey, reading);
    }
    return reading;
  }
  private async readMemories(pubkey: string): Promise<readonly Memory[]> {
    const snapshot = this.relay(pubkey)?.snapshot();
    if (snapshot?.status !== "ready") throw new Error("Buzz is not connected");
    const view = snapshot.session.agentMemories.open(pubkey);
    try {
      const done = new Promise<void>((resolve) => {
        const settled = () =>
          !["idle", "loading"].includes(view.snapshot().status) && resolve();
        view.subscribe(settled);
        settled();
      });
      void view.refresh();
      await Promise.race([
        done,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Memory read timed out")),
            MEMORY_TIMEOUT_MS,
          ),
        ),
      ]);
      const { status, listing } = view.snapshot();
      if (status !== "ready" || !listing)
        throw new Error(`Memory unavailable (${status})`);
      return listing.entries;
    } finally {
      view.dispose();
    }
  }
}
