import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Delivery,
  type Models,
} from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import type { EventData } from "../../features/relay/events";
import { appClient } from "../../buzz-mcp/app-client";
import { TOOLS, callTool } from "../../buzz-mcp/tools";
import {
  config,
  defaults,
  absoluteWorkspace,
  effortName,
  validWorkspace,
  type Config,
} from "./config";
import { conversationHistory } from "./history";
import {
  developerInstructions,
  rootOf,
  sessionName,
  turnInput,
  type Conversation,
} from "./prompt";
import {
  AppServer,
  listModels,
  type Spawn,
  type ToolCall,
  type ToolReply,
} from "./rpc";

type Request = {
  /** The agent's community and owner, as `origin:viewer`. */
  scope: string;
  event: EventData;
  agent: AgentHandle;
  settings: Config;
  conversation: Conversation;
  /** Latest request's thread, independent of session scope; absent in DMs. */
  toolRoot?: string;
  interest: string;
  /** The agent's team sections, if it is on a team. */
  team: string;
  /** The model and effort the owner picked for this turn. */
  model?: string;
  effort?: string;
  /** Called once a final send answers this request, or one steered after it. */
  answered: () => void;
};
type Saved = { threadId: string; workspace: string };
type Active = {
  /** The server this turn runs on; steering must reach the same process. */
  rpc: AppServer;
  threadId?: string;
  turnId?: string;
  ready: Promise<void>;
  steering: Promise<void>;
  reply: Request;
  finished: boolean;
  workspace: string;
  signal: AbortSignal;
  version: number;
  sentVersion?: number;
  /** Every request this turn has taken in, the first and each steered one. */
  requests: Request[];
};
type Lane = {
  tail: Promise<void>;
  active?: Active;
};
type Entry = {
  storageKey: string;
  abort: AbortController;
  /** Settles once the same agent's previous run has let go of its threads. */
  after: Promise<void>;
  lanes: Map<string, Lane>;
  saved: Record<string, Saved>;
};
type Server = {
  rpc: AppServer;
  opening: Promise<AppServer>;
  /** Threads this process has loaded, and the agent each belongs to. */
  threads: Map<string, string>;
};
export type SessionView = { key: string; status: string; detail: string };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function textOf(event: EventData, name: string) {
  let text = event.content.trim().replace(/^🤖\s+/, "");
  if (text.startsWith(`@${name}`)) text = text.slice(name.length + 1).trim();
  return text;
}

/** Agents owns admission/identity. This plugin owns work after hand-over, and
 * uses one app-server for every agent. Each conversation is its own Codex
 * thread carrying its agent's workspace, instructions and tools, and tool
 * calls find their agent by thread and turn. */
export class CodexRuntime {
  private entries = new Map<string, Entry>();
  private server: Server | undefined;
  private stopping = new Map<string, Promise<void>>();
  private views = new Map<string, readonly SessionView[]>();
  private listeners = new Set<() => void>();
  /** Read-only model discovery, kept per agent until its settings change. */
  private previews = new Map<string, { key: string; ready: Promise<Models> }>();
  constructor(
    private readonly spawn: Spawn,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
    private readonly storage: Storage = localStorage,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  sessions = (pubkey: string): readonly SessionView[] =>
    this.views.get(pubkey) ?? EMPTY;
  preview(agent: Agent) {
    const settings = config(agent.config);
    const key = JSON.stringify([
      settings.workspace,
      settings.model,
      settings.effort,
    ]);
    const existing = this.previews.get(agent.pubkey);
    if (existing?.key === key) return existing.ready;
    const server = this.open();
    const rpc = server.rpc;
    const ready = (async () => {
      const workspace = await this.workspace(settings.workspace);
      await server.opening;
      const normalized = await rpc.request<{
        config: { model?: string | null };
      }>("config/read", { cwd: workspace });
      const models = await listModels(rpc);
      const model =
        settings.model ||
        normalized.config.model ||
        models.find((row) => row.isDefault)?.model;
      const offered = models.map((row) => {
        const efforts = row.supportedReasoningEfforts.map(
          ({ reasoningEffort: id }) => ({ id, label: effortName(id) }),
        );
        // As a run picks it: the configured effort if the model has it.
        const effort = efforts.some((level) => level.id === settings.effort)
          ? settings.effort
          : row.defaultReasoningEffort;
        return {
          id: row.model,
          label: row.displayName || row.model,
          efforts,
          ...(effort ? { effort } : {}),
        };
      });
      // A configured model this Codex does not list still leaves the
      // listed ones to pick, so the picker stays.
      return !model || models.some((row) => row.model === model)
        ? { current: model ?? "", models: offered }
        : {
            current: model,
            models: [{ id: model, label: model, efforts: [] }, ...offered],
          };
    })();
    const entry = { key, ready };
    this.previews.set(agent.pubkey, entry);
    void ready.catch(() => {
      if (this.previews.get(agent.pubkey) === entry)
        this.previews.delete(agent.pubkey);
    });
    return ready;
  }

  private async workspace(path: string) {
    if (absoluteWorkspace(path)) return path;
    let directory = "";
    const process = await this.spawn("workspace", {
      cwd: path,
      onStdout: (data) => {
        directory += data;
      },
    });
    const code = await process.exited;
    const workspace = directory.trim();
    if (code !== 0 || !absoluteWorkspace(workspace))
      throw new Error("Could not resolve the default Codex workspace.");
    return workspace;
  }
  private status(pubkey: string, key: string, status: string, detail = "") {
    // A stopped agent's draining turns don't bring its sessions back.
    if (!this.entries.has(pubkey)) return;
    const others = this.sessions(pubkey).filter((view) => view.key !== key);
    this.views.set(pubkey, [
      ...others.slice(-31),
      { key, status, detail: detail.slice(0, 4000) },
    ]);
    for (const listener of this.listeners) listener();
  }
  sync(agents: readonly Agent[]) {
    const present = new Set(agents.map((agent) => agent.pubkey));
    for (const pubkey of this.previews.keys())
      if (!present.has(pubkey)) {
        this.previews.delete(pubkey);
      }
    for (const [pubkey, entry] of this.entries)
      if (!present.has(pubkey)) {
        entry.abort.abort();
        this.entries.delete(pubkey);
        this.views.delete(pubkey);
        if (this.server) this.stop(this.server, pubkey, entry);
      }
    if (!present.size) this.close();
    for (const listener of this.listeners) listener();
  }
  /** Other agents share the server, so a stopped agent's turns interrupt
   * themselves. Then the shells its finished turns left are ended, which its
   * own process used to do by exiting. Until then, the same agent starting
   * again waits rather than resuming a thread that is still letting go. */
  private stop(server: Server, pubkey: string, entry: Entry) {
    const stopped = (async () => {
      await Promise.all(
        [...entry.lanes.values()].map((lane) =>
          lane.tail.catch(() => undefined),
        ),
      );
      for (const [threadId, owner] of server.threads)
        if (owner === pubkey) {
          server.threads.delete(threadId);
          await server.rpc
            .request("thread/backgroundTerminals/clean", { threadId })
            .catch(() => undefined);
        }
    })();
    this.stopping.set(pubkey, stopped);
    void stopped.finally(() => {
      if (this.stopping.get(pubkey) === stopped) this.stopping.delete(pubkey);
    });
  }
  dispose() {
    this.previews.clear();
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
    this.views.clear();
    this.stopping.clear();
    this.close();
  }
  private close() {
    void this.server?.rpc.close();
    this.server = undefined;
  }
  private open() {
    if (this.server) return this.server;
    const rpc = new AppServer((call) => this.tool(call));
    // Threads set their own cwd; the process just needs a directory that exists.
    const server: Server = {
      rpc,
      opening: rpc.open(this.spawn, defaults.workspace),
      threads: new Map(),
    };
    // An exit fails current work and permits the next ordinary mention to reopen.
    rpc.onMessage((wire) => {
      if (wire.method === "connection/closed" && this.server === server)
        this.server = undefined;
    });
    void server.opening.catch(() => {
      if (this.server === server) this.server = undefined;
      void rpc.close();
    });
    this.server = server;
    return server;
  }
  private entry(request: Request) {
    const pubkey = request.agent.pubkey;
    const prior = this.entries.get(pubkey);
    if (prior) return prior;
    let saved: Record<string, Saved> = {};
    try {
      const stored: unknown = JSON.parse(
        this.storage.getItem(this.storageKey(request)) ?? "{}",
      );
      if (stored && typeof stored === "object" && !Array.isArray(stored))
        saved = Object.fromEntries(
          Object.entries(stored).filter(
            ([, value]) =>
              value &&
              typeof value.threadId === "string" &&
              typeof value.workspace === "string",
          ),
        );
    } catch {
      /* Start fresh after malformed local data. */
    }
    const entry: Entry = {
      storageKey: this.storageKey(request),
      abort: new AbortController(),
      after: this.stopping.get(pubkey) ?? Promise.resolve(),
      saved,
      lanes: new Map(),
    };
    this.entries.set(pubkey, entry);
    return entry;
  }
  private storageKey(request: Request) {
    // Resume restores the persisted tool schema; pre-tools bindings start fresh.
    return `buzz.codex.sessions.v3:${request.scope}:${request.agent.pubkey}`;
  }
  private save(request: Request, entry: Entry, key: string, saved: Saved) {
    entry.saved[key] = saved;
    // Retain a bounded set of bindings; this never deletes Codex's own history.
    entry.saved = Object.fromEntries(Object.entries(entry.saved).slice(-200));
    try {
      this.storage.setItem(entry.storageKey, JSON.stringify(entry.saved));
    } catch (error) {
      this.status(
        request.agent.pubkey,
        key,
        "Session could not be saved",
        message(error),
      );
    }
  }
  async run(delivery: Delivery) {
    delivery.signal.throwIfAborted();
    const { trigger, agent } = delivery;
    if (trigger.type === "timer")
      throw new Error(
        "Codex timers are not supported yet; use mentions or event watches.",
      );
    if (!(await fromOwner(trigger.event, agent.owner))) return;
    const snapshot = this.relay(agent.pubkey)?.snapshot();
    if (snapshot?.status !== "ready")
      throw new Error("Connect to the agent's community first");
    const channelId = delivery.channelId;
    if (!channelId) throw new Error("The event has no unambiguous channel");
    const settings = config(delivery.config);
    const channel = snapshot.session.channels
      .list()
      .channels.find((row) => row.id === channelId);
    const toolRoot =
      channel?.channelType === "dm" ? undefined : rootOf(trigger.event);
    const root = settings.scope === "channel" ? undefined : toolRoot;
    let answered!: () => void;
    // Codex makes one more model call after a final send before its turn
    // ends; the agent is done working on this request once it has replied.
    const replied = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const request: Request = {
      scope: snapshot.scope ?? "",
      event: trigger.event,
      agent,
      settings,
      ...(toolRoot ? { toolRoot } : {}),
      ...(delivery.model ? { model: delivery.model } : {}),
      ...(delivery.effort ? { effort: delivery.effort } : {}),
      conversation: {
        channelId,
        name: channel?.name ?? channelId,
        ...(root ? { root } : {}),
      },
      interest:
        trigger.type === "watch" ? (trigger.interest?.instructions ?? "") : "",
      team: delivery.team ?? "",
      answered,
    };
    if (!validWorkspace(settings.workspace)) {
      await this.publish(
        request,
        "Choose an absolute workspace path or ~/.buzz in Codex settings first.",
      );
      return;
    }
    const key = JSON.stringify([channelId, root ?? "channel"]);
    const text = textOf(request.event, agent.name);
    const entry = this.entry(request);
    let lane = entry.lanes.get(key);
    if (!lane) {
      lane = { tail: entry.after };
      entry.lanes.set(key, lane);
    }
    if (lane.active) {
      const active = lane.active;
      // Startup and history reads stay ordered without holding Agents delivery.
      const accepted = active.steering.then(async () => {
        try {
          await active.ready;
          if (entry.abort.signal.aborted) return;
          if (active.finished) {
            this.start(request, text, key, lane, entry);
            return;
          }
          const context = await this.history(request, entry.abort.signal);
          if (entry.abort.signal.aborted) return;
          if (active.finished) {
            this.start(request, text, key, lane, entry);
            return;
          }
          await active.rpc.request("turn/steer", {
            threadId: active.threadId,
            expectedTurnId: active.turnId,
            input: input(
              `${context}${turnInput(request.event, request.conversation, text, request.interest, true)}`,
            ),
          });
          active.reply = request;
          active.requests.push(request);
          active.version++;
        } catch (error) {
          if (entry.abort.signal.aborted) return;
          // A completion racing the request means this is the next ordinary turn.
          if (message(error) === "no active turn to steer") {
            this.start(request, text, key, lane, entry);
            return;
          }
          await this.publish(
            request,
            `Steering was not accepted: ${message(error)}. Send another mention to continue.`,
          );
        }
      });
      active.steering = accepted.catch((error) =>
        console.error("Codex steering failed", error),
      );
      // The steered turn, or one started in its place, answers this mention.
      const steered = lane;
      delivery.workingUntil(
        Promise.race([replied, accepted.then(() => steered.tail)]),
      );
      return;
    }
    delivery.workingUntil(
      Promise.race([replied, this.start(request, text, key, lane, entry)]),
    );
  }
  private start(
    request: Request,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
  ) {
    const current = lane;
    const job = lane.tail
      .catch(() => undefined)
      .then(async () => {
        if (entry.abort.signal.aborted) return;
        await this.execute(request, text, key, current, entry);
      });
    lane.tail = job;
    this.status(request.agent.pubkey, key, "Starting");
    // Agents can deliver follow-ups and other conversations immediately.
    void job
      .catch((error) => console.error("Codex turn failed", error))
      .finally(() => {
        if (current.tail === job && !current.active) entry.lanes.delete(key);
      });
    return job;
  }
  private async history(request: Request, signal: AbortSignal) {
    signal.throwIfAborted();
    const snapshot = this.relay(request.agent.pubkey)?.snapshot();
    if (snapshot?.status !== "ready" || snapshot.scope !== request.scope)
      throw new Error("The community changed");
    return conversationHistory(request.event, request.conversation, (filters) =>
      snapshot.session.read(filters, { signal }),
    );
  }
  // Tags the owner even when a sibling asked: tagging the sibling would wake
  // it, and two agents failing alike would wake each other without end.
  private publish(request: Request, content: string) {
    return request.agent.publish({
      kind: 9,
      content,
      tags: [
        ["h", request.conversation.channelId],
        ["e", rootOf(request.event), "", "reply"],
        ["p", request.agent.owner],
      ],
    });
  }
  private async tool(call: ToolCall): Promise<ToolReply> {
    const active = [...this.entries.values()]
      .flatMap((entry) => [...entry.lanes.values()])
      .map((lane) => lane.active)
      .find(
        (active) =>
          active?.threadId === call?.threadId &&
          active?.turnId === call?.turnId,
      );
    if (
      !active ||
      call.namespace !== "buzz" ||
      !TOOLS.some((tool) => tool.name === call.tool)
    )
      throw new Error("No active Buzz tool for this thread and turn");
    const check = () => {
      active.signal.throwIfAborted();
      if (active.finished) throw new Error("The Codex turn has ended");
    };
    check();
    if (
      !call.arguments ||
      typeof call.arguments !== "object" ||
      Array.isArray(call.arguments)
    )
      throw new Error("Buzz tool arguments must be an object");
    const args = call.arguments as Record<string, unknown>;
    const version = active.version;
    const request = active.reply;
    const answering = [...active.requests];
    const client = appClient(request.agent, {
      spawn: this.spawn,
      cwd: active.workspace,
      check,
      signal: active.signal,
      memories: async () => {
        const snapshot = this.relay(request.agent.pubkey)?.snapshot();
        if (snapshot?.status !== "ready" || snapshot.scope !== request.scope)
          throw new Error("Buzz is not connected to this community");
        const view = snapshot.session.agentMemories.open(request.agent.pubkey);
        const abort = () => view.dispose();
        active.signal.addEventListener("abort", abort, { once: true });
        try {
          await view.refresh();
          check();
          const { status, listing } = view.snapshot();
          if (status !== "ready" || !listing)
            throw new Error(`Memory unavailable (${status})`);
          return listing.entries;
        } finally {
          active.signal.removeEventListener("abort", abort);
          view.dispose();
        }
      },
    });
    const text = await callTool(
      client,
      {
        channel: request.conversation.channelId,
        ...(request.toolRoot ? { root: request.toolRoot } : {}),
      },
      call.tool,
      args,
    );
    const final = call.tool === "send" && args.final === true;
    if (final) {
      active.sentVersion = Math.max(active.sentVersion ?? -1, version);
      for (const taken of answering) taken.answered();
    }
    return { success: true, contentItems: [{ type: "inputText", text }] };
  }
  private async terminals(rpc: AppServer, threadId: string) {
    // Interrupt acknowledges the turn, not the death of separately grouped shells.
    try {
      await rpc.request("thread/backgroundTerminals/clean", { threadId });
      // clean acknowledges submission. Direct termination is the completion
      // barrier for any shells still reported by the server.
      let cursor: string | null = null;
      do {
        const page: {
          data: { processId: string }[];
          nextCursor: string | null;
        } = await rpc.request("thread/backgroundTerminals/list", {
          threadId,
          limit: 100,
          cursor,
        });
        await Promise.all(
          page.data.map((terminal) =>
            rpc.request("thread/backgroundTerminals/terminate", {
              threadId,
              processId: terminal.processId,
            }),
          ),
        );
        cursor = page.nextCursor;
      } while (cursor);
      const remaining = await rpc.request<{ data: unknown[] }>(
        "thread/backgroundTerminals/list",
        { threadId, limit: 1 },
      );
      if (remaining.data.length)
        throw new Error("Codex background terminals could not be stopped");
    } catch (error) {
      // A failed cleanup must not leave shells unreachable behind an idle lane.
      await rpc.close();
      throw error;
    }
  }
  private async execute(
    request: Request,
    text: string,
    key: string,
    lane: Lane,
    entry: Entry,
  ) {
    let ready!: () => void;
    let notReady!: (error: unknown) => void;
    const turnAbort = new AbortController();
    const server = this.open();
    const signal = AbortSignal.any([
      entry.abort.signal,
      turnAbort.signal,
      AbortSignal.timeout(29 * 60_000),
    ]);
    const active: Active = {
      rpc: server.rpc,
      ready: new Promise((resolve, reject) => {
        ready = resolve;
        notReady = reject;
      }),
      steering: Promise.resolve(),
      reply: request,
      finished: false,
      workspace: request.settings.workspace,
      signal,
      version: 0,
      requests: [request],
    };
    void active.ready.catch(() => undefined);
    lane.active = active;
    const { settings, agent } = request;
    let finish!: (status: string) => void;
    let fail!: (error: Error) => void;
    const completed = new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    void completed.catch(() => undefined);
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const off = server.rpc.onMessage((wire) => {
      const p = wire.params as
        | {
            threadId?: string;
            message?: string;
            turn?: { id: string; status: string; error?: { message: string } };
            item?: {
              type: string;
              text?: string;
              phase?: string;
              command?: string;
              aggregatedOutput?: string;
            };
          }
        | undefined;
      if (wire.method === "connection/closed") {
        fail(new Error(p?.message ?? "Codex connection closed"));
        return;
      }
      if (!p || p.threadId !== active.threadId) return;
      if (wire.method === "turn/started" && p.turn) active.turnId = p.turn.id;
      if (wire.method === "item/started" && p.item?.command)
        this.status(agent.pubkey, key, "Working", p.item.command);
      if (
        wire.method === "item/completed" &&
        p.item?.type === "commandExecution"
      )
        this.status(
          agent.pubkey,
          key,
          "Working",
          `${p.item.command ?? ""}\n${p.item.aggregatedOutput ?? ""}`,
        );
      if (wire.method === "turn/completed" && p.turn) {
        active.finished = true;
        if (p.turn.status === "failed")
          fail(new Error(p.turn.error?.message ?? "Codex turn failed"));
        else finish(p.turn.status);
      }
    });
    try {
      const rpc = await server.opening;
      signal.throwIfAborted();
      // The process host expands ~/.buzz and creates it; Codex's RPC needs
      // an absolute path rather than shell-style home notation.
      const workspace = await this.workspace(settings.workspace);
      signal.throwIfAborted();
      active.workspace = workspace;
      const existing = entry.saved[key];
      const normalized = await rpc.request<{
        config: {
          model?: string | null;
          mcp_servers?: Record<string, Record<string, unknown>>;
        };
      }>("config/read", { cwd: workspace });
      const models = await listModels(rpc);
      const own =
        settings.model ||
        normalized.config.model ||
        models.find((row) => row.isDefault)?.model;
      // Model and effort are per turn, so a pick changes nothing after it.
      const picked = models.find((row) => row.model === request.model);
      const selected = picked ?? models.find((row) => row.model === own);
      if (!selected)
        throw new Error(
          "The selected Codex model is unavailable. Choose an available model in Settings.",
        );
      const model = selected.model;
      const supported = selected.supportedReasoningEfforts.map(
        (level) => level.reasoningEffort,
      );
      // A picked model may not support the configured effort.
      const effort =
        [request.effort, settings.effort].find(
          (level) => level && supported.includes(level),
        ) ?? selected.defaultReasoningEffort;
      const mcp = Object.fromEntries(
        Object.entries(normalized.config.mcp_servers ?? {}).map(
          ([name, server]) => [
            name,
            // CLI overrides replace this table; disabled servers still need a transport.
            {
              ...(typeof server.command === "string"
                ? { command: server.command }
                : { url: server.url }),
              enabled: false,
            },
          ],
        ),
      );
      const params = {
        model,
        cwd: workspace,
        developerInstructions: developerInstructions(agent),
        approvalPolicy: "never",
        // Matches Claude Code's bypassPermissions; only the owner can start work.
        sandbox: "danger-full-access",
        config: {
          web_search: "disabled",
          mcp_servers: mcp,
          "features.plugins": false,
          "features.apps": false,
        },
      };
      const resuming = existing?.workspace === workspace;
      let started: { thread: { id: string; cwd: string } };
      try {
        started = await rpc.request<typeof started>(
          resuming ? "thread/resume" : "thread/start",
          {
            ...params,
            ...(resuming
              ? { threadId: existing?.threadId, excludeTurns: true }
              : {
                  dynamicTools: DYNAMIC_TOOLS,
                }),
          },
        );
      } catch (error) {
        if (
          !resuming ||
          message(error) !==
            `no rollout found for thread id ${existing?.threadId}`
        )
          throw error;
        started = await rpc.request<typeof started>("thread/start", {
          ...params,
          dynamicTools: DYNAMIC_TOOLS,
        });
      }
      active.threadId = started.thread.id;
      server.threads.set(active.threadId, agent.pubkey);
      signal.throwIfAborted();
      await rpc.request("thread/name/set", {
        threadId: active.threadId,
        name: sessionName(agent, request.conversation),
      });
      const context = await this.history(request, signal);
      signal.throwIfAborted();
      const turn = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId: active.threadId,
        input: input(
          `${context}${turnInput(request.event, request.conversation, text, request.interest)}`,
        ),
        model,
        effort,
        // Application context is a developer message that updates on each turn.
        additionalContext: {
          "buzz.instructions": {
            kind: "application",
            value: developerInstructions(agent, settings, request.team),
          },
        },
      });
      active.turnId = turn.turn.id;
      // Empty threads have no resumable rollout until a user turn is accepted.
      this.save(request, entry, key, {
        threadId: started.thread.id,
        workspace,
      });
      ready();
      this.status(agent.pubkey, key, "Working");
      const status = await completed;
      await active.steering;
      signal.throwIfAborted();
      if (status === "interrupted") {
        await this.terminals(rpc, active.threadId);
        await this.publish(
          active.reply,
          "Codex’s turn was interrupted. Send another mention to continue.",
        );
        this.status(agent.pubkey, key, "Interrupted");
      } else {
        if (active.sentVersion !== active.version)
          await this.publish(
            active.reply,
            "Codex ended this turn without a final reply through buzz.send. Send another mention to ask it to continue.",
          );
        this.status(agent.pubkey, key, "Idle");
      }
    } catch (error) {
      const ended = active.finished;
      active.finished = true;
      notReady(error);
      await active.steering;
      // Other agents share the server, so even a stopped agent interrupts
      // its turn rather than ending the process.
      if (signal.aborted && !ended && active.threadId && active.turnId) {
        try {
          await server.rpc.request("turn/interrupt", {
            threadId: active.threadId,
            turnId: active.turnId,
          });
          await this.terminals(server.rpc, active.threadId);
        } catch {
          await server.rpc.close();
        }
      }
      if (!entry.abort.signal.aborted) {
        const reason = `Codex could not finish: ${message(error)}.`;
        await this.publish(active.reply, reason).catch((failure) =>
          console.error("Codex could not publish its failure", failure),
        );
        this.status(agent.pubkey, key, "Needs attention", reason);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      turnAbort.abort(new Error("The Codex turn has ended"));
      off();
      // Release the subscription before the next resume: loaded-thread rejoin
      // ignores instruction/config overrides while a client is subscribed.
      if (active.threadId)
        await server.rpc
          .request("thread/unsubscribe", { threadId: active.threadId })
          .catch(() => server.rpc.close());
      if (lane.active === active) delete lane.active;
    }
  }
}
const DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "buzz",
    description: "Read and act in Buzz as this agent.",
    tools: TOOLS.map((tool) => ({ type: "function", ...tool })),
  },
];
const EMPTY: readonly SessionView[] = Object.freeze([]);
