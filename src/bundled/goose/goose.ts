// One `goose-acp` process, driven over ACP's line-delimited JSON-RPC. Each
// conversation an agent is in is one ACP session in it, in the agent's
// workspace. Each session gets its own loopback HTTP MCP server for its agent's
// Buzz tools, which the app serves and answers: goose is given its address and
// token in `session/new`, never a Buzz key.
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
  McpHandler,
} from "../../features/host/service";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;
export type ServeMcp = (handler: McpHandler) => Promise<HostMcpServer>;
/** The desktop host's `spawn` and `resolveDirectory`, which goose starts with. */
export type GooseHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** The most of a turn's text kept, to post when it answers nowhere in Buzz. */
const WRITTEN_LIMIT = 20_000;
/** The Buzz tools that answer where people see it. A read, or a send that
 * failed, still leaves goose's text to post. */
const ANSWERS = new Set(["send", "edit", "react"]);
const STOPPED =
  "Buzz stopped this session's tools: another program used their token";

/** How long goose has to answer a request that starts it or opens or closes
 * a session. One that does not is stopped. A turn's prompt is never timed. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** How a burst of work ended: every message sent so far has been answered,
 * or the session or its process is gone. One message of the burst owns its
 * `error` and `text`, to post them once; the others get only `ok`. */
export type Settled = Readonly<{
  ok: boolean;
  error?: string;
  /** What goose wrote, when it answered nowhere in Buzz. Nobody saw it. */
  text?: string;
}>;

export type ActivityReceipt = Readonly<{
  /** Steps show on the latest acknowledged message of each scope. */
  activityScope?: string;
  step?: (tool: string, target?: string) => void;
  acknowledged?: () => void;
  superseded?: () => void;
}>;

/** Answers one MCP message from a session serving `conversation` with its
 * JSON-RPC response. */
export type ToolServer = (
  conversation: string | undefined,
  message: Readonly<{ id: string | number; method: string; params?: unknown }>,
) => Promise<unknown>;

/** The HTTP MCP server every session declares; goose names its tools
 * `buzz__<name>`. */
export const TOOL_SERVER = "buzz";
const DEVELOPER = { type: "platform", name: "developer" };

/** What every `goose-acp` runs with: tools run without asking, and no Buzz
 * identity reaches it from the app's environment. Nor does a provider or
 * model, which goose would prefer to each session's. */
export const ENV: Readonly<Record<string, string | null>> = {
  GOOSE_MODE: "auto",
  BUZZ_PRIVATE_KEY: null,
  BUZZ_AUTH_TAG: null,
  BUZZ_RELAY_URL: null,
  GOOSE_PROVIDER: null,
  GOOSE_MODEL: null,
};

/** The provider, model and thinking level a session's turns run on; empty is
 * what goose's config picks. */
export type Choice = Readonly<{
  provider: string;
  model: string;
  effort?: string | undefined;
}>;
type ConfigOptions = {
  configOptions?: {
    category?: string | null;
    currentValue?: string;
    options?: { value: string }[];
  }[];
};
const thinkingOption = (config: ConfigOptions | undefined) =>
  config?.configOptions?.find((option) => option.category === "thought_level");
/** goose's provider id for the provider and model its config picks. */
const CONFIGURED = "goose";

const STDERR_LIMIT = 4_000;
const STEP_KEYS = [
  "description",
  "path",
  "file_path",
  "pattern",
  "url",
  "query",
  "command",
];

type Wire = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
};
type Waiter = (settled: Settled) => void;
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class GooseProcess {
  readonly exited: Promise<number | null>;
  private readonly sessions = new Map<string, GooseSession>();
  private readonly calls = new Map<number, Pending>();
  private requests = 0;
  private buffer = "";
  private stderr = "";
  private alive = true;
  /** goose names an untitled session with a model call, unless its config
   * sets `GOOSE_DISABLE_SESSION_NAMING`; `names` reads it once. */
  private naming: Promise<boolean> | undefined;

  private constructor(
    private readonly process: HostProcess,
    private readonly serve: ServeMcp | undefined,
  ) {
    this.exited = process.exited.then((code) => {
      this.alive = false;
      const error = new Error(
        this.stderr.trim().split("\n").at(-1) ||
          `goose exited (${code ?? "signal"})`,
      );
      for (const call of this.calls.values()) call.reject(error);
      this.calls.clear();
      for (const session of this.sessions.values()) {
        session.fail(error.message);
        void session.server?.close();
      }
      this.sessions.clear();
      return code;
    });
  }

  /** Starts `goose-acp` and checks it can reach the Buzz tools. Sessions
   * with tools need `serve`, which starts their MCP server. */
  static async start(
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ) {
    let goose: GooseProcess | undefined;
    const early: string[] = [];
    const process = await spawn("goose", {
      cwd: launch.cwd,
      env: { ...ENV, ...launch.env },
      onStdout: (data) => (goose ? goose.read(data) : early.push(data)),
      onStderr: (data) => goose?.readError(data),
    }).catch((error: unknown) => {
      throw /os error 2|no such file|not found/i.test(errorMessage(error))
        ? new Error("goose-acp is missing from this Buzz build.")
        : error;
    });
    goose = new GooseProcess(process, launch.serve);
    for (const data of early) goose.read(data);
    try {
      const init = (await goose.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "buzz", version: "1" },
        },
        REQUEST_TIMEOUT_MS,
      )) as {
        agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
      };
      if (!init.agentCapabilities?.mcpCapabilities?.http)
        throw new Error(
          "This goose cannot reach Buzz tools (no HTTP MCP support)",
        );
    } catch (error) {
      void process.kill();
      throw error;
    }
    return goose;
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return [...this.sessions.values()].some((session) => session.busy);
  }

  /** Opens a new session in `cwd`, named `title`, whose system prompt has
   * `systemPrompt` appended. With `named`, goose names it instead when it
   * names sessions, and `named` takes that name. `tools` answers its Buzz
   * tools; without them it has no tools at all. Each turn runs on the
   * provider and model `choice` gives as it starts. */
  async open(
    launch: Readonly<{
      cwd: string;
      systemPrompt: string;
      title?: string;
      named?: (title: string) => void;
      tools?: ToolServer;
      choice?: () => Choice;
    }>,
  ): Promise<GooseSession> {
    const named =
      launch.named && (await this.names()) ? launch.named : undefined;
    const title = named ? undefined : launch.title;
    const provider = launch.choice?.().provider ?? "";
    let server: HostMcpServer | undefined;
    // goose connects while it opens the session, before it is known here.
    let session: GooseSession | undefined;
    const { tools } = launch;
    if (tools) {
      if (!this.serve) throw new Error("This goose serves no Buzz tools");
      server = await this.serve((message) => this.mcp(tools, session, message));
    }
    const buzz = server && {
      type: "http",
      name: TOOL_SERVER,
      url: server.url,
      headers: server.headers,
    };
    // The host stops a server whose token a second client used, so the
    // session's tools may be someone else's. A session closed here has
    // already left `sessions`.
    let stopped = false;
    void server?.closed.then(() => {
      stopped = true;
      if (session && this.sessions.get(session.id) === session) {
        session.fail(STOPPED);
        void this.close(session);
      }
    });
    let sessionId: string;
    let config: ConfigOptions | undefined;
    try {
      const opened = (await this.request(
        "session/new",
        {
          cwd: launch.cwd,
          mcpServers: buzz ? [buzz] : [],
          _meta: {
            // The session's whole tool set: goose's developer tools and the
            // Buzz tools, so extensions in the owner's goose config and
            // plugins never load into a Buzz agent. goose stores this list
            // with the session. Since aaif-goose/goose#12908 it leaves out
            // the Buzz entry and holds the `mcpServers` copy in memory, so
            // the token stays out of sessions.db; older goose uses this one.
            enabledExtensions: buzz
              ? [DEVELOPER, { type: "mcp", server: buzz }]
              : [],
            ...(title ? { sessionTitle: title } : {}),
            // On the provider's default model, whatever goose's config holds.
            ...(provider ? { provider } : {}),
          },
        },
        REQUEST_TIMEOUT_MS,
      )) as { sessionId: string } & ConfigOptions;
      sessionId = opened.sessionId;
      config = opened;
    } catch (error) {
      void server?.close();
      throw error;
    }
    session = new GooseSession(
      this,
      sessionId,
      server,
      launch.choice,
      {
        provider,
        model: "",
      },
      config,
    );
    session.named = named;
    this.sessions.set(sessionId, session);
    if (stopped) {
      void this.close(session);
      throw new Error(STOPPED);
    }
    try {
      // Appended under goose's own prompt, which carries each extension's
      // instructions; `set` would replace it, and render ours as a template.
      if (launch.systemPrompt)
        await this.request(
          "_goose/unstable/session/system-prompt/set",
          { sessionId, mode: "append", key: "buzz", text: launch.systemPrompt },
          REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
      void this.close(session);
      throw error;
    }
    return session;
  }

  private names() {
    this.naming ??= this.request(
      "_goose/unstable/config/read",
      { key: "GOOSE_DISABLE_SESSION_NAMING", isSecret: false },
      REQUEST_TIMEOUT_MS,
    ).then(
      (result) => {
        const { value } = result as { value?: unknown };
        return value !== true && value !== "true";
      },
      () => true,
    );
    return this.naming;
  }

  /** Ends a session. Its turn, if any, is cancelled first. */
  async close(session: GooseSession) {
    if (!this.sessions.delete(session.id)) return;
    session.fail("The session was closed");
    void session.server?.close();
    if (!this.alive) return;
    this.notify("session/cancel", { sessionId: session.id });
    await this.request(
      "session/close",
      { sessionId: session.id },
      REQUEST_TIMEOUT_MS,
    ).catch((error) => console.warn("goose did not close a session", error));
  }

  kill() {
    return this.process.kill();
  }

  /** Sends a request and resolves with its result. When goose does not
   * answer within `timeout` ms it is stopped, which fails its sessions. */
  request(method: string, params: Record<string, unknown>, timeout?: number) {
    if (!this.alive) return Promise.reject(new Error("goose is not running"));
    const id = ++this.requests;
    const answer = new Promise<unknown>((resolve, reject) => {
      if (timeout === undefined) return this.calls.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(
          new Error(
            `goose did not answer ${method} in ${Math.round(timeout / 1000)}s`,
          ),
        );
        void this.kill();
      }, timeout);
      this.calls.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      this.calls.get(id)?.reject(new Error(String(error)));
      this.calls.delete(id);
    });
    return answer;
  }
  notify(method: string, params: Record<string, unknown>) {
    void this.write({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  private write(message: Wire) {
    return this.process.write(`${JSON.stringify(message)}\n`);
  }
  private readError(data: string) {
    this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
  }
  private read(data: string) {
    this.buffer += data;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  private handle(message: Wire) {
    const { id, method } = message;
    if (method === undefined) {
      if (typeof id !== "number") return;
      const call = this.calls.get(id);
      this.calls.delete(id);
      if (message.error) call?.reject(new Error(errorMessage(message.error)));
      else call?.resolve(message.result);
      return;
    }
    if (id === undefined || id === null) {
      if (method === "session/update") this.update(message.params ?? {});
      return;
    }
    void this.answer(id, method, message.params ?? {});
  }
  private update(params: Record<string, unknown>) {
    const session = this.sessions.get(String(params.sessionId));
    const update = params.update as Record<string, unknown> | undefined;
    if (session && update) session.update(update);
  }
  /** Answers what goose asks its client: since tools run without asking,
   * any permission prompt with allow. */
  private async answer(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ) {
    let reply: Wire;
    if (method === "session/request_permission")
      reply = { jsonrpc: "2.0", id, result: { outcome: allow(params) } };
    else
      reply = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Buzz does not handle ${method}` },
      };
    return this.write(reply).catch(() => undefined);
  }
  /** One MCP message for a session's Buzz tools, answered with its JSON-RPC
   * response; a notification gets none. A final `send` that succeeded ends
   * its turn. The host answers a throw with an internal error. */
  private async mcp(
    tools: ToolServer,
    session: GooseSession | undefined,
    message: unknown,
  ): Promise<Wire | undefined> {
    const { id, method = "", params } = (message ?? {}) as Wire;
    if (id === undefined || id === null) return undefined;
    const response = (await tools(session?.conversation, {
      id,
      method,
      params,
    })) as Wire;
    const call = (params ?? {}) as {
      name?: unknown;
      arguments?: { final?: unknown };
    };
    const worked =
      method === "tools/call" &&
      !response.error &&
      !(response.result as { isError?: unknown } | undefined)?.isError;
    if (worked && ANSWERS.has(String(call.name))) session?.answered();
    if (worked && call.name === "send" && call.arguments?.final === true)
      session?.finished();
    return response;
  }
}

/** One conversation's ACP session. Messages sent while a turn runs are
 * steered into it; one that arrives as the turn ends, or asks for another
 * model, runs as the next turn. */
export class GooseSession {
  /** The conversation it serves. */
  conversation: string | undefined;
  /** Takes the first name goose generates for it; a titled session gets none. */
  named: ((title: string) => void) | undefined;
  /** goose's id for the running turn, which a steer must name. */
  private runId: string | undefined;
  /** Steers waiting for the running turn's id, which goose sends just after
   * the turn starts. */
  private runWaiters: ((runId: string | undefined) => void)[] = [];
  /** A `session/prompt` is in flight. */
  private prompting = false;
  private steering = 0;
  /** Turns to run, each with the model and effort it was asked for, if any. */
  private readonly queue: { text: string; model?: string; effort?: string }[] =
    [];
  /** The thinking levels Goose currently offers for the session's model. */
  private effortLevels: readonly string[] = [];
  /** The session's thinking level before a per-message override. */
  private baselineEffort = "";
  /** Whether a message pick still needs its fallback restored. */
  private messageEffortApplied = false;
  /** The saved choice, used to detect when its Thinking setting is cleared. */
  private configuredEffort = "";
  /** The model the running turn runs on; empty is its provider's default. */
  private model = "";
  /** Messages sent and not yet answered. */
  private pending = 0;
  private waiters: Waiter[] = [];
  /** The waiter that posts the burst's error or text: the latest message
   * acknowledged, else the latest sent. */
  private owner: Waiter | undefined;
  private readonly active = new Map<string, ActivityReceipt>();
  private lastStep = "";
  private lastError: string | undefined;
  /** Whether this work answered in Buzz, and what goose wrote meanwhile: a
   * provider failure comes back as text, and text is never posted. */
  private acted = false;
  private written = "";
  private closed = false;
  /** The work the owner stopped, while goose ends it: the messages it had
   * taken, and their activity. What goose wrote meanwhile is not posted, and
   * messages sent since wait for a turn of their own. */
  private stopped:
    | { waiters: Waiter[]; receipts: Set<ActivityReceipt> }
    | undefined;
  private idlers: (() => void)[] = [];

  constructor(
    private readonly goose: GooseProcess,
    readonly id: string,
    /** Serves this session's Buzz tools; closed with it. */
    readonly server?: HostMcpServer,
    private readonly choice?: () => Choice,
    /** The provider and model it runs on, as chosen here. */
    private chosen: Choice = { provider: "", model: "" },
    config?: ConfigOptions,
  ) {
    this.observeThinking(config, true);
  }

  get busy() {
    return this.pending > 0;
  }
  get working() {
    return !this.quiet();
  }
  get open() {
    return !this.closed;
  }
  /** Saved effort drives stale-session detection; message picks reset in place. */
  get effort() {
    return this.messageEffortApplied ? "" : this.configuredEffort;
  }
  /** Resolves once nothing runs, waits to run or waits for its answer:
   * unlike `busy`, it waits out the model call goose makes after a final
   * `send` too. */
  idle(): Promise<void> {
    if (this.quiet()) return Promise.resolve();
    return new Promise((resolve) => this.idlers.push(resolve));
  }

  /** Sends one user message, whose turn runs on `model` of the provider when
   * given. Resolves when it, and anything sent after it, has been answered,
   * or a final `send` ended the work. */
  send(
    text: string,
    activity: ActivityReceipt = {},
    model?: string,
    effort?: string,
  ): Promise<Settled> {
    if (this.closed)
      return Promise.resolve({ ok: false, error: "The session was closed" });
    this.pending++;
    let waiter!: Waiter;
    const settled = new Promise<Settled>((resolve) => {
      waiter = resolve;
      this.waiters.push(resolve);
    });
    // Only steer while an earlier user message is still pending. A final Buzz
    // send can settle it before goose's trailing prompt call returns.
    if (
      this.prompting &&
      this.pending > 1 &&
      !this.stopped &&
      !this.queue.length &&
      effort === undefined &&
      (!model || model === this.model)
    )
      void this.steer(text, activity, waiter, model);
    else {
      this.queue.push({
        text,
        ...(model ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      });
      this.acknowledge(activity, waiter);
      void this.pump();
    }
    return settled;
  }

  /** A final `send` succeeded: the work counts as done at once, unless
   * another message is still waiting for its answer. goose still ends its turn
   * with one more model call, whose text nobody posts. */
  finished() {
    if (this.pending === 1 && !this.queue.length && !this.steering)
      this.settle({ ok: true });
  }

  /** Stops the work: the running turn, as ACP's `session/cancel` does, and
   * the messages waiting for a turn after it, which goose cannot stop apart.
   * A turn not yet sent is never sent. The work then ends as goose ends it;
   * a message sent before it has runs as a new turn after. */
  interrupt() {
    if (!this.working || this.closed) return;
    this.queue.length = 0;
    this.stopped = {
      waiters: [...this.waiters],
      receipts: new Set(this.active.values()),
    };
    this.goose.notify("session/cancel", { sessionId: this.id });
  }

  /** A Buzz tool that answers, such as `send`, succeeded. */
  answered() {
    this.acted = true;
  }

  /** Called by the process with each `session/update` for this session. */
  update(update: Record<string, unknown>) {
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" && !this.acted) {
      const content = update.content as { text?: unknown } | undefined;
      if (typeof content?.text === "string")
        this.written = (this.written + content.text).slice(0, WRITTEN_LIMIT);
    }
    if (kind === "session_info_update") {
      const title = typeof update.title === "string" ? update.title.trim() : "";
      const named = this.named;
      if (title && named) {
        this.named = undefined;
        named(title);
      }
      const goose = (update._meta as { goose?: { activeRunId?: unknown } })
        ?.goose;
      if (goose && "activeRunId" in goose) {
        this.runId =
          typeof goose.activeRunId === "string" ? goose.activeRunId : undefined;
        if (this.runId) this.ranAs(this.runId);
      }
      return;
    }
    const step = stepLabel(update);
    if (!step) return;
    const label = `${step.tool}\u0000${step.target ?? ""}`;
    if (label === this.lastStep) return;
    this.lastStep = label;
    for (const receipt of this.active.values())
      receipt.step?.(step.tool, step.target);
  }

  /** Ends the session's work with `error`; nothing more is sent to it. */
  fail(error: string) {
    this.closed = true;
    this.queue.length = 0;
    this.settle({ ok: false, error });
  }

  private async steer(
    text: string,
    activity: ActivityReceipt,
    waiter: Waiter,
    model?: string,
  ) {
    this.steering++;
    // Work the owner stopped, or that ended meanwhile, takes no more.
    const live = () =>
      this.waiters.includes(waiter) && !this.stopped?.waiters.includes(waiter);
    try {
      const runId =
        this.runId ??
        (this.prompting
          ? await new Promise<string | undefined>((resolve) =>
              this.runWaiters.push(resolve),
            )
          : undefined);
      if (runId) {
        try {
          await this.goose.request("_goose/unstable/session/steer", {
            sessionId: this.id,
            prompt: [{ type: "text", text }],
            expectedRunId: runId,
          });
          if (live()) this.acknowledge(activity, waiter);
          return;
        } catch {
          // The turn ended, or another took its place: run it as the next.
        }
      }
      if (live()) {
        this.queue.push({ text, ...(model ? { model } : {}) });
        this.acknowledge(activity, waiter);
      }
    } finally {
      this.steering--;
      // Runs the next turn, or ends work whose turn ended during the steer.
      void this.pump();
    }
  }

  private async pump() {
    if (this.prompting) return;
    this.prompting = true;
    try {
      while (this.queue.length && !this.closed) {
        // Stopped work has ended, and messages sent since run as new work.
        if (this.stopped) this.endStopped();
        const { text, model, effort } = this.queue.shift() ?? { text: "" };
        try {
          await this.select(model, effort);
          // The owner stopped it while its provider switch was going.
          if (this.stopped) continue;
          const { stopReason } = (await this.goose.request("session/prompt", {
            sessionId: this.id,
            prompt: [{ type: "text", text }],
          })) as { stopReason?: string };
          if (stopReason === "refusal")
            this.lastError = "goose refused the request";
        } catch (error) {
          this.lastError = errorMessage(error);
        }
      }
    } finally {
      this.prompting = false;
      this.runId = undefined;
      this.ranAs(undefined);
    }
    if (!this.steering && !this.closed) this.done();
    this.wake();
  }

  /** Puts the session on the provider, model and thinking level chosen now,
   * or `model` of that provider. A steer joins the running turn, so a change
   * waits for the next. */
  private async select(model?: string, effort?: string) {
    if (effort !== undefined && !effort)
      throw new Error("goose cannot apply an empty thinking_effort");
    const chosen = this.choice?.();
    if (!chosen) return;
    const want = model ? { ...chosen, model } : chosen;
    const savedEffort = want.effort ?? "";
    const providerChanges =
      want.provider !== this.chosen.provider ||
      (this.chosen.model && !want.model);
    this.model = want.model;
    if (providerChanges) {
      // goose keeps the model when the provider stays the same.
      if (want.provider && want.provider === this.chosen.provider)
        this.observeThinking(
          await this.configure("model", await this.defaultModel(want.provider)),
        );
      else
        this.observeThinking(
          await this.configure("provider", want.provider || CONFIGURED),
        );
      this.chosen = { ...this.chosen, provider: want.provider, model: "" };
    }
    if (want.model !== this.chosen.model) {
      this.observeThinking(await this.configure("model", want.model));
      this.chosen = { ...this.chosen, model: want.model };
    }

    const fallback = savedEffort || this.baselineEffort;
    const requested =
      effort ?? (this.messageEffortApplied ? fallback : savedEffort);
    const target =
      this.messageEffortApplied &&
      effort === undefined &&
      requested &&
      !this.effortLevels.includes(requested)
        ? (this.effortLevels[0] ?? requested)
        : requested;
    const canApplyEffort =
      effort !== undefined || !target || this.effortLevels.includes(target);
    if (
      (target || this.messageEffortApplied) &&
      (target !== (this.chosen.effort ?? "") || this.messageEffortApplied) &&
      canApplyEffort
    )
      await this.setThinking(target);
    if (effort !== undefined) this.messageEffortApplied = target !== fallback;
    else if (canApplyEffort) this.messageEffortApplied = false;
    if (savedEffort) this.configuredEffort = savedEffort;
  }

  private async setThinking(target: string) {
    if (target && !this.effortLevels.includes(target))
      throw new Error(`goose does not support thinking_effort ${target}`);
    const configured = await this.configure("thinking_effort", target);
    const option = thinkingOption(configured);
    if (option?.currentValue !== undefined && option.currentValue !== target)
      throw new Error(`goose did not apply thinking_effort ${target}`);
    if (option?.options)
      this.effortLevels = option.options.map(({ value }) => value);
    this.chosen = { ...this.chosen, effort: target || undefined };
  }

  private observeThinking(
    config: ConfigOptions | undefined,
    captureBaseline = false,
  ) {
    const option = thinkingOption(config);
    this.effortLevels = option?.options?.map(({ value }) => value) ?? [];
    const current = option?.currentValue ?? "";
    if (captureBaseline) this.baselineEffort = current;
    this.chosen = { ...this.chosen, effort: current || undefined };
  }

  private async configure(configId: string, value: string) {
    try {
      return (await this.goose.request("session/set_config_option", {
        sessionId: this.id,
        configId,
        value,
      })) as ConfigOptions;
    } catch (error) {
      throw new Error(
        `goose could not switch its ${configId} to ${value}: ${errorMessage(error)}`,
      );
    }
  }
  private async defaultModel(provider: string) {
    const { entries } = (await this.goose.request(
      "_goose/unstable/providers/list",
      { providerIds: [provider] },
    )) as { entries: { providerId: string; defaultModel?: string }[] };
    const model = entries.find(
      (entry) => entry.providerId === provider,
    )?.defaultModel;
    if (!model) throw new Error(`goose has no default model for ${provider}`);
    return model;
  }

  private ranAs(runId: string | undefined) {
    for (const resolve of this.runWaiters.splice(0)) resolve(runId);
  }
  private acknowledge(activity: ActivityReceipt, waiter: Waiter) {
    if (this.waiters.includes(waiter)) this.owner = waiter;
    // Watches and timers have no message activity: they must not hide a mention.
    if (!activity.step) return;
    const scope = activity.activityScope ?? "conversation";
    this.active.get(scope)?.superseded?.();
    this.active.set(scope, activity);
    this.lastStep = "";
    activity.acknowledged?.();
  }
  private done() {
    // Work that wrote text and never answered in Buzz answered only goose: a
    // model that forgot `send`, or goose saying it cannot reach its provider.
    const text = this.acted || this.stopped ? "" : this.written.trim();
    const error = this.lastError;
    this.settle({
      ...(error ? { ok: false, error } : { ok: true }),
      ...(text ? { text } : {}),
    });
  }
  /** Settles the work the owner stopped, leaving messages sent since. */
  private endStopped() {
    const stopped = this.stopped;
    if (!stopped) return;
    this.stopped = undefined;
    const error = this.lastError;
    this.lastError = undefined;
    this.acted = false;
    this.written = "";
    for (const [scope, receipt] of this.active)
      if (stopped.receipts.has(receipt)) this.active.delete(scope);
    const owner =
      this.owner && stopped.waiters.includes(this.owner)
        ? this.owner
        : stopped.waiters.at(-1);
    if (this.owner === owner) this.owner = undefined;
    this.waiters = this.waiters.filter(
      (waiter) => !stopped.waiters.includes(waiter),
    );
    this.pending = this.waiters.length;
    for (const resolve of stopped.waiters)
      resolve(
        resolve === owner && error ? { ok: false, error } : { ok: !error },
      );
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.active.clear();
    this.lastError = undefined;
    this.acted = false;
    this.written = "";
    this.stopped = undefined;
    const owner = this.owner ?? this.waiters.at(-1);
    this.owner = undefined;
    for (const resolve of this.waiters.splice(0))
      resolve(resolve === owner ? settled : { ok: settled.ok });
    this.wake();
  }
  private quiet() {
    return (
      this.closed ||
      (!this.prompting && !this.steering && !this.pending && !this.queue.length)
    );
  }
  private wake() {
    if (this.quiet()) for (const resolve of this.idlers.splice(0)) resolve();
  }
}

/** A `session/update` as the step it shows: a tool call by its title and
 * target, thinking, or writing. */
export function stepLabel(
  update: Record<string, unknown>,
): { tool: string; target?: string } | undefined {
  switch (update.sessionUpdate) {
    case "tool_call": {
      const title = typeof update.title === "string" ? update.title : "";
      // goose titles a call `shell · sleep 10`, or `buzz: send`.
      const tool =
        title.split(" · ")[0]?.split(/__|: /).at(-1)?.trim() || "Tool";
      const input = (update.rawInput ?? {}) as Record<string, unknown>;
      const target = STEP_KEYS.map((key) => input[key]).find(
        (value): value is string => typeof value === "string" && !!value,
      );
      return target ? { tool, target: shortTarget(target) } : { tool };
    }
    case "agent_thought_chunk":
      return { tool: "Thinking" };
    case "agent_message_chunk":
      return { tool: "Writing reply" };
    default:
      return undefined;
  }
}

/** The option that allows the call, preferring one that keeps allowing. */
function allow(params: Record<string, unknown>) {
  const options = Array.isArray(params.options)
    ? (params.options as { optionId?: unknown; kind?: unknown }[])
    : [];
  const option =
    options.find((item) => item.kind === "allow_always") ??
    options.find((item) => item.kind === "allow_once");
  return option && typeof option.optionId === "string"
    ? { outcome: "selected", optionId: option.optionId }
    : { outcome: "cancelled" };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const { message, data } = error as { message: unknown; data?: unknown };
    return typeof data === "string" && data
      ? `${message}: ${data}`
      : String(message);
  }
  return String(error);
}

function shortTarget(value: string) {
  return value.startsWith("/") ? (value.split("/").at(-1) ?? value) : value;
}
