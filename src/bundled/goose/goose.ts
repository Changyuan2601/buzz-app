// One `goose-acp` process for one agent, driven over ACP's line-delimited
// JSON-RPC. Each conversation the agent is in is one ACP session in it. Each
// session gets its own loopback HTTP MCP server for the Buzz tools, which the
// app serves and answers: goose is given its address and token in
// `session/new`, never a Buzz key.
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

/** The most of a turn's text kept, to post when it answers nowhere in Buzz. */
const WRITTEN_LIMIT = 20_000;
/** The Buzz tools that answer where people see it. A read, or a send that
 * failed, still leaves goose's text to post. */
const ANSWERS = new Set(["send", "edit", "react"]);
const STOPPED =
  "Buzz stopped this session's tools: another program used their token";

/** How a burst of work ended: every message sent so far has been answered,
 * or the session or its process is gone. */
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

/** What every `goose-acp` runs with: tools run without asking, sessions are
 * not named (one model call per turn, not two), and no Buzz identity reaches
 * it from the app's environment. */
export const ENV: Readonly<Record<string, string | null>> = {
  GOOSE_MODE: "auto",
  GOOSE_DISABLE_SESSION_NAMING: "true",
  BUZZ_PRIVATE_KEY: null,
  BUZZ_AUTH_TAG: null,
  BUZZ_RELAY_URL: null,
};

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

  private constructor(
    private readonly process: HostProcess,
    private readonly tools: ToolServer,
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
      tools: ToolServer;
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
    goose = new GooseProcess(process, launch.tools, launch.serve);
    for (const data of early) goose.read(data);
    try {
      const init = (await goose.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "buzz", version: "1" },
      })) as {
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
   * `systemPrompt` appended. A `bare` one has no tools at all. */
  async open(
    launch: Readonly<{
      cwd: string;
      systemPrompt: string;
      title?: string;
      bare?: boolean;
    }>,
  ): Promise<GooseSession> {
    let server: HostMcpServer | undefined;
    // goose connects while it opens the session, before it is known here.
    let session: GooseSession | undefined;
    if (!launch.bare) {
      if (!this.serve) throw new Error("This goose serves no Buzz tools");
      server = await this.serve((message) => this.mcp(session, message));
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
    try {
      ({ sessionId } = (await this.request("session/new", {
        cwd: launch.cwd,
        mcpServers: buzz ? [buzz] : [],
        _meta: {
          // The session's whole tool set: goose's developer tools and the
          // Buzz tools, so extensions in the owner's goose config and plugins
          // never load into a Buzz agent. goose then ignores `mcpServers`.
          enabledExtensions: buzz
            ? [DEVELOPER, { type: "mcp", server: buzz }]
            : [],
          ...(launch.title ? { sessionTitle: launch.title } : {}),
        },
      })) as { sessionId: string });
    } catch (error) {
      void server?.close();
      throw error;
    }
    session = new GooseSession(this, sessionId, server);
    this.sessions.set(sessionId, session);
    if (stopped) {
      void this.close(session);
      throw new Error(STOPPED);
    }
    try {
      // Appended under goose's own prompt, which carries each extension's
      // instructions; `set` would replace it, and render ours as a template.
      if (launch.systemPrompt)
        await this.request("_goose/unstable/session/system-prompt/set", {
          sessionId,
          mode: "append",
          key: "buzz",
          text: launch.systemPrompt,
        });
    } catch (error) {
      void this.close(session);
      throw error;
    }
    return session;
  }

  /** Ends a session. Its turn, if any, is cancelled first. */
  async close(session: GooseSession) {
    this.sessions.delete(session.id);
    session.fail("The session was closed");
    void session.server?.close();
    if (!this.alive) return;
    this.notify("session/cancel", { sessionId: session.id });
    await this.request("session/close", { sessionId: session.id }).catch(
      (error) => console.warn("goose did not close a session", error),
    );
  }

  kill() {
    return this.process.kill();
  }

  /** Sends a request and resolves with its result. */
  request(method: string, params: Record<string, unknown>) {
    if (!this.alive) return Promise.reject(new Error("goose is not running"));
    const id = ++this.requests;
    const answer = new Promise<unknown>((resolve, reject) =>
      this.calls.set(id, { resolve, reject }),
    );
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
    session: GooseSession | undefined,
    message: unknown,
  ): Promise<Wire | undefined> {
    const { id, method = "", params } = (message ?? {}) as Wire;
    if (id === undefined || id === null) return undefined;
    const response = (await this.tools(session?.conversation, {
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
 * steered into it; one that arrives as the turn ends runs as the next turn. */
export class GooseSession {
  /** The conversation it serves. */
  conversation: string | undefined;
  /** goose's id for the running turn, which a steer must name. */
  private runId: string | undefined;
  /** Steers waiting for the running turn's id, which goose sends just after
   * the turn starts. */
  private runWaiters: ((runId: string | undefined) => void)[] = [];
  /** A `session/prompt` is in flight. */
  private prompting = false;
  private steering = 0;
  private readonly queue: string[] = [];
  /** Messages sent and not yet answered. */
  private pending = 0;
  private waiters: ((settled: Settled) => void)[] = [];
  private readonly active = new Map<string, ActivityReceipt>();
  private lastStep = "";
  private lastError: string | undefined;
  /** Whether this work answered in Buzz, and what goose wrote meanwhile: a
   * provider failure comes back as text, and text is never posted. */
  private acted = false;
  private written = "";
  private closed = false;

  constructor(
    private readonly goose: GooseProcess,
    readonly id: string,
    /** Serves this session's Buzz tools; closed with it. */
    readonly server?: HostMcpServer,
  ) {}

  get busy() {
    return this.pending > 0;
  }
  get open() {
    return !this.closed;
  }

  /** Sends one user message. Resolves when it, and anything sent after it,
   * has been answered, or a final `send` ended the work. */
  send(text: string, activity: ActivityReceipt = {}): Promise<Settled> {
    if (this.closed)
      return Promise.resolve({ ok: false, error: "The session was closed" });
    this.pending++;
    const settled = new Promise<Settled>((resolve) =>
      this.waiters.push(resolve),
    );
    if (this.prompting) void this.steer(text, activity);
    else {
      this.queue.push(text);
      this.acknowledge(activity);
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

  private async steer(text: string, activity: ActivityReceipt) {
    this.steering++;
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
          this.acknowledge(activity);
          return;
        } catch {
          // The turn ended, or another took its place: run it as the next.
        }
      }
      this.queue.push(text);
      this.acknowledge(activity);
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
        const text = this.queue.shift() ?? "";
        try {
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
  }

  private ranAs(runId: string | undefined) {
    for (const resolve of this.runWaiters.splice(0)) resolve(runId);
  }
  private acknowledge(activity: ActivityReceipt) {
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
    const text = this.acted ? "" : this.written.trim();
    const error = this.lastError;
    this.settle({
      ...(error ? { ok: false, error } : { ok: true }),
      ...(text ? { text } : {}),
    });
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.active.clear();
    this.lastError = undefined;
    this.acted = false;
    this.written = "";
    for (const resolve of this.waiters.splice(0)) resolve(settled);
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
