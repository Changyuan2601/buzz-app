// One `claude` process driven over its stream-json protocol: the protocol the
// Claude Agent SDK speaks to the same binary, so no Node runtime is needed. The
// process stays alive between turns; messages sent while it works are folded
// into the running turn at its next tool call. Buzz tools are served over the
// same pipe, as the SDK serves an in-process MCP server, so the process holds
// no Buzz key.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;

export type ClaudeLaunch = Readonly<{
  cwd: string;
  /** Appended to Claude Code's own system prompt. */
  systemPrompt: string;
  model?: string;
  /** A saved session to continue. */
  resume?: string;
  /** The id a new session takes, so it is known before its first turn. */
  sessionId?: string;
  /** The in-process MCP server's tools. */
  tools?: ToolServer;
}>;

/** Answers the in-process server's JSON-RPC for the conversation a process
 * serves. A call of `send` with `final: true` ends the turn when it succeeds. */
export type ToolServer = (
  conversation: string | undefined,
  message: unknown,
) => Promise<unknown>;
/** Its tools are `mcp__buzz__<name>`. */
export const TOOL_SERVER = "buzz";
const FINAL_TOOL = `mcp__${TOOL_SERVER}__send`;

type Message = Record<string, unknown> & { type?: string; subtype?: string };

/** How a burst of work ended: every message sent so far has been answered,
 * or the process is gone. */
export type Settled = Readonly<{
  ok: boolean;
  /** Why it failed, for the person waiting. */
  error?: string;
}>;

const STDERR_LIMIT = 4_000;
/** What `claude` is started with: as the SDK starts it, reporting when it is
 * idle, signed in as `claude auth login` left it, and never as part of a
 * Claude Code session that started the app. */
export const ENV: Readonly<Record<string, string | null>> = {
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  // A key in the shell that launched the app would outrank the sign-in; the
  // interactive CLI asks before using one, but stream-json mode uses it silently.
  ANTHROPIC_API_KEY: null,
  CLAUDECODE: null,
  CLAUDE_CODE_SESSION_ID: null,
  CLAUDE_CODE_CHILD_SESSION: null,
  CLAUDE_CODE_MESSAGING_SOCKET: null,
  CLAUDE_CODE_MESSAGING_TOKEN: null,
  CLAUDE_CODE_SESSION_ATTENDED: null,
  CLAUDE_AGENT_SDK_VERSION: null,
  CLAUDE_PID: null,
};

export class ClaudeProcess {
  /** Its session, known once the first turn starts (or at once when resuming). */
  sessionId: string | undefined;
  /** The conversation it serves, set when a spare is put to use. */
  conversation: string | undefined;
  /** Messages sent and not yet answered. */
  private pending = 0;
  /** It has begun a turn, so its session loaded. */
  private began = false;
  private waiters: ((settled: Settled) => void)[] = [];
  private buffer = "";
  private stderr = "";
  private lastError: string | undefined;
  private alive = true;
  /** It reports idle; an older `claude` that does not is settled per result. */
  private reportsState = false;
  private requests = 0;
  readonly exited: Promise<number | null>;

  private constructor(
    private readonly process: HostProcess,
    resume: string | undefined,
    private tools: ToolServer | undefined,
  ) {
    this.sessionId = resume;
    this.exited = process.exited.then((code) => {
      this.alive = false;
      const error =
        this.lastError ??
        (this.stderr.trim().split("\n").at(-1) ||
          `Claude Code exited (${code ?? "signal"})`);
      this.settle({ ok: false, error });
      return code;
    });
  }

  static async start(spawn: Spawn, launch: ClaudeLaunch) {
    const claude = await ClaudeProcess.spawn(spawn, launch);
    await claude.initialize(launch);
    return claude;
  }

  /** Starts `claude` without its prompt. This is most of what a start costs,
   * and fixes nothing about the agent it serves but its folder and model. */
  static async spawn(spawn: Spawn, launch: Omit<ClaudeLaunch, "systemPrompt">) {
    let claude: ClaudeProcess | undefined;
    const early: string[] = [];
    const earlyErrors: string[] = [];
    const process = await spawn("claude", {
      args: [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.resume ? ["--resume", launch.resume] : []),
        ...(!launch.resume && launch.sessionId
          ? ["--session-id", launch.sessionId]
          : []),
        ...(launch.tools
          ? [
              "--mcp-config",
              JSON.stringify({
                mcpServers: {
                  // Listed up front, so Claude need not search for them first.
                  [TOOL_SERVER]: {
                    type: "sdk",
                    name: TOOL_SERVER,
                    alwaysLoad: true,
                  },
                },
              }),
            ]
          : []),
      ],
      cwd: launch.cwd,
      env: ENV,
      onStdout: (data) => (claude ? claude.read(data) : early.push(data)),
      onStderr: (data) =>
        claude ? claude.readError(data) : earlyErrors.push(data),
    });
    claude = new ClaudeProcess(
      process,
      launch.resume ?? launch.sessionId,
      launch.tools,
    );
    for (const data of earlyErrors) claude.readError(data);
    for (const data of early) claude.read(data);
    return claude;
  }

  /** Gives a started process its prompt, and its tools to whoever it now
   * works for. Loads settings and tools now rather than on the first message. */
  async initialize(launch: Pick<ClaudeLaunch, "systemPrompt" | "tools">) {
    if (launch.tools) this.tools = launch.tools;
    await this.request({
      subtype: "initialize",
      appendSystemPrompt: launch.systemPrompt,
      ...(launch.tools
        ? {
            sdkMcpServers: [TOOL_SERVER],
            hooks: {
              PostToolUse: [
                { matcher: FINAL_TOOL, hookCallbackIds: ["final"] },
              ],
            },
          }
        : {}),
    });
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return this.pending > 0;
  }
  get started() {
    return this.began;
  }

  /** Sends one user message. Resolves when it, and anything sent after it, has
   * been answered and the session is idle again. */
  send(text: string): Promise<Settled> {
    if (!this.alive)
      return Promise.resolve({
        ok: false,
        error: "Claude Code is not running",
      });
    this.pending++;
    const settled = new Promise<Settled>((resolve) =>
      this.waiters.push(resolve),
    );
    this.write({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    }).catch((error) =>
      this.settle({
        ok: false,
        error: `Claude Code did not take the message: ${error}`,
      }),
    );
    return settled;
  }

  kill() {
    return this.process.kill();
  }

  private write(message: Message) {
    return this.process.write(`${JSON.stringify(message)}\n`);
  }
  private async request(request: Message) {
    await this.write({
      type: "control_request",
      request_id: `buzz-${++this.requests}`,
      request,
    });
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.lastError = undefined;
    for (const resolve of this.waiters.splice(0)) resolve(settled);
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
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  private handle(message: Message) {
    if (typeof message.session_id === "string" && message.session_id)
      this.sessionId = message.session_id;
    if (message.type === "system" && message.subtype === "init")
      this.began = true;
    if (message.type === "control_request") {
      void this.answer(message);
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      this.reportsState = true;
      if (message.state === "idle" && this.pending) this.done();
      return;
    }
    if (message.type !== "result") return;
    // An interrupt is not a failure to report.
    if (message.is_error && message.terminal_reason !== "aborted_streaming")
      this.lastError =
        typeof message.result === "string" && message.result
          ? message.result
          : `Claude Code stopped (${String(message.subtype)})`;
    if (!this.reportsState && this.pending) this.done();
  }
  private done() {
    const error = this.lastError;
    this.settle(error ? { ok: false, error } : { ok: true });
  }
  /** Answers what Claude Code asks its host: calls to the Buzz tools, the
   * hook after `send`, and, since permissions are bypassed, anything else only
   * so an unexpected request does not stall the turn. */
  private async answer(message: Message) {
    const id = message.request_id;
    const request = (message.request ?? {}) as Message;
    const success = (response: unknown) => ({
      subtype: "success",
      request_id: id,
      response,
    });
    let response: Message;
    if (request.subtype === "mcp_message" && this.tools)
      response = success({
        mcp_response: await this.tools(
          this.conversation,
          request.message,
        ).catch((error) => ({
          jsonrpc: "2.0",
          id: (request.message as Message | undefined)?.id ?? 0,
          error: { code: -32603, message: String(error?.message ?? error) },
        })),
      });
    else if (request.subtype === "can_use_tool")
      response = success({
        behavior: "allow",
        updatedInput: request.input ?? {},
      });
    else if (request.subtype === "hook_callback")
      response = success(this.final(request.input) ? { continue: false } : {});
    else
      response = {
        subtype: "error",
        request_id: id,
        error: `Buzz does not handle ${String(request.subtype)}`,
      };
    return this.write({ type: "control_response", response }).catch(
      () => undefined,
    );
  }
  /** A `send` marked final succeeded (a failed call runs no PostToolUse
   * hook), so the turn can end without a closing model call. Not when another
   * message came in meanwhile: that one still needs an answer. */
  private final(input: unknown) {
    const { tool_name, tool_input } = (input ?? {}) as Message;
    return (
      tool_name === FINAL_TOOL &&
      (tool_input as Message | undefined)?.final === true &&
      this.pending === 1
    );
  }
}
