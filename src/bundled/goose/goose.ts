// One `goose-acp` process for one agent, driven over ACP's line-delimited
// JSON-RPC. Each conversation the agent is in is one ACP session in it. The
// Buzz tools are served over the same pipe with MCP-over-ACP: a session
// declares an `acp` MCP server, and goose sends that server's MCP messages
// back as `mcp/message` requests, so the process holds no Buzz key.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;

/** How a burst of work ended: every message sent so far has been answered,
 * or the session or its process is gone. */
/** The most of a turn's text kept, to post when it calls no Buzz tool. */
const WRITTEN_LIMIT = 20_000;

export type Settled = Readonly<{
  ok: boolean;
  error?: string;
  /** What goose wrote, when it called no Buzz tool. Nobody in Buzz saw it. */
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
  message: Readonly<{ id: string; method: string; params?: unknown }>,
) => Promise<unknown>;

/** The `acp` MCP server every session declares; goose names its tools
 * `buzz__<name>`. */
export const TOOL_SERVER = "buzz";
const ACP_SERVER = { type: "acp", name: TOOL_SERVER, serverId: TOOL_SERVER };
/** The whole tool set: goose's own developer tools and the Buzz tools. Sent
 * as the session's selection, so extensions in the owner's goose config and
 * plugins never load into a Buzz agent. */
const EXTENSIONS = [
  { type: "platform", name: "developer" },
  { type: "mcp", server: ACP_SERVER },
];

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
  ) {
    this.exited = process.exited.then((code) => {
      this.alive = false;
      const error = new Error(
        this.stderr.trim().split("\n").at(-1) ||
          `goose exited (${code ?? "signal"})`,
      );
      for (const call of this.calls.values()) call.reject(error);
      this.calls.clear();
      for (const session of this.sessions.values()) session.fail(error.message);
      this.sessions.clear();
      return code;
    });
  }

  /** Starts `goose-acp` and checks it can serve the Buzz tools. */
  static async start(
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      tools: ToolServer;
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
        ? new Error(
            "goose-acp is not installed. Buzz looks for it on your PATH, including ~/.local/bin.",
          )
        : error;
    });
    goose = new GooseProcess(process, launch.tools);
    for (const data of early) goose.read(data);
    try {
      const init = (await goose.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "buzz", version: "1" },
      })) as {
        agentCapabilities?: { mcpCapabilities?: { acp?: boolean } };
      };
      if (!init.agentCapabilities?.mcpCapabilities?.acp)
        throw new Error(
          "This goose cannot serve Buzz tools (no MCP-over-ACP support)",
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
    const { sessionId } = (await this.request("session/new", {
      cwd: launch.cwd,
      mcpServers: launch.bare ? [] : [ACP_SERVER],
      _meta: {
        enabledExtensions: launch.bare ? [] : EXTENSIONS,
        ...(launch.title ? { sessionTitle: launch.title } : {}),
      },
    })) as { sessionId: string };
    const session = new GooseSession(this, sessionId);
    this.sessions.set(sessionId, session);
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
  /** Answers what goose asks its client: the Buzz tools' MCP messages and,
   * since tools run without asking, any permission prompt with allow. */
  private async answer(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ) {
    let reply: Wire;
    if (method === "mcp/message") reply = await this.mcp(id, params);
    else if (method === "session/request_permission")
      reply = { jsonrpc: "2.0", id, result: { outcome: allow(params) } };
    else
      reply = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Buzz does not handle ${method}` },
      };
    return this.write(reply).catch(() => undefined);
  }
  /** One MCP message for the Buzz tools. Its outcome is the response's
   * `result` or `error`; a final `send` that succeeded ends its turn. */
  private async mcp(
    id: number | string,
    params: Record<string, unknown>,
  ): Promise<Wire> {
    const sessionId = String(
      (params._meta as { sessionId?: unknown } | undefined)?.sessionId ?? "",
    );
    const method = String(params.method ?? "");
    const inner = {
      id: String(params.requestId ?? id),
      method,
      params: params.params,
    };
    if (params.serverId !== TOOL_SERVER)
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `No MCP server ${String(params.serverId)}`,
        },
      };
    let response: Wire;
    try {
      response = (await this.tools(
        this.sessions.get(sessionId)?.conversation,
        inner,
      )) as Wire;
    } catch (error) {
      response = { error: { code: -32603, message: errorMessage(error) } };
    }
    const session = this.sessions.get(sessionId);
    if (method === "tools/call") session?.used();
    if (response.error)
      return { jsonrpc: "2.0", id, result: { error: response.error } };
    const call = (inner.params ?? {}) as {
      name?: unknown;
      arguments?: { final?: unknown };
    };
    if (
      method === "tools/call" &&
      call.name === "send" &&
      call.arguments?.final === true &&
      !(response.result as { isError?: unknown } | undefined)?.isError
    )
      session?.finished();
    return { jsonrpc: "2.0", id, result: { result: response.result } };
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
  /** Whether this work called a Buzz tool, and what goose wrote meanwhile: a
   * provider failure comes back as text, and text is never posted. */
  private acted = false;
  private written = "";
  private closed = false;

  constructor(
    private readonly goose: GooseProcess,
    readonly id: string,
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

  /** goose called a Buzz tool. */
  used() {
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
    }
    void this.pump();
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
    // Work that wrote text and never acted in Buzz answered only goose: a
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
