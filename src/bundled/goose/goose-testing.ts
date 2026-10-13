// A stand-in for `goose-acp`'s ACP over stdio, for tests.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export type FakeTurn = {
  sessionId: string;
  runId: string;
  text: string;
  /** Texts steered into it. */
  steered: string[];
  finish(stopReason?: string): void;
};

export type FakeGoose = {
  id: string;
  options: HostProcessOptions;
  /** Every message written to its stdin. */
  received: Message[];
  /** Each `session/new`'s params. */
  opened: Record<string, unknown>[];
  /** Each system prompt set, by session. */
  prompts: Map<string, string>;
  /** Turns, in the order they began. */
  turns: FakeTurn[];
  closed: string[];
  cancelled: string[];
  /** When set, a turn stays open until it is finished. */
  hold: boolean;
  killed: boolean;
  /** Asks the client a request and resolves with its response. */
  ask(method: string, params: Record<string, unknown>): Promise<Message>;
  /** An MCP message for the Buzz tools from `sessionId`. */
  mcp(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Message>;
  update(sessionId: string, update: Record<string, unknown>): void;
  exit(code: number | null, stderr?: string): void;
};

/** A spawn whose `goose` processes answer like `goose-acp`, and whose
 * `workspace` process prints `home` for a `~/…` directory. */
export function fakeSpawn(
  options: Readonly<{ acp?: boolean; home?: string; hold?: boolean }> = {},
) {
  const processes: FakeGoose[] = [];
  const spawn = async (
    id: string,
    process: HostProcessOptions = {},
  ): Promise<HostProcess> => {
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    if (id === "workspace") {
      const cwd = process.cwd ?? "";
      queueMicrotask(() => {
        process.onStdout?.(
          `${cwd.replace(/^~/, options.home ?? "/home/test")}\n`,
        );
        resolveExit(0);
      });
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited,
      };
    }
    let alive = true;
    let sessions = 0;
    let requests = 0;
    const answers = new Map<number | string, (message: Message) => void>();
    const send = (message: Message) =>
      queueMicrotask(() => {
        if (alive) process.onStdout?.(`${JSON.stringify(message)}\n`);
      });
    const reply = (id: number | string | undefined, result: unknown) =>
      send({ jsonrpc: "2.0", ...(id !== undefined && { id }), result });
    const running = new Map<string, FakeTurn>();
    const fake: FakeGoose = {
      id,
      options: process,
      received: [],
      opened: [],
      prompts: new Map(),
      turns: [],
      closed: [],
      cancelled: [],
      hold: options.hold ?? false,
      killed: false,
      ask: (method, params) => {
        const requestId = `goose-${++requests}`;
        const answer = new Promise<Message>((resolve) =>
          answers.set(requestId, resolve),
        );
        send({ jsonrpc: "2.0", id: requestId, method, params });
        return answer;
      },
      mcp: (sessionId, method, params = {}) =>
        fake.ask("mcp/message", {
          serverId: "buzz",
          requestId: `mcp-${requests + 1}`,
          method,
          params,
          _meta: { sessionId },
        }),
      update: (sessionId, update) =>
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        }),
      exit: (code, stderr = "") => {
        if (!alive) return;
        if (stderr) process.onStderr?.(stderr);
        alive = false;
        resolveExit(code);
      },
    };
    processes.push(fake);
    const handle = (message: Message) => {
      fake.received.push(message);
      const { id, method, params = {} } = message;
      if (method === undefined) {
        if (id !== undefined) answers.get(id)?.(message);
        answers.delete(id ?? "");
        return;
      }
      const sessionId = String(params.sessionId ?? "");
      switch (method) {
        case "initialize":
          return reply(id, {
            protocolVersion: 1,
            agentCapabilities: {
              mcpCapabilities: { acp: options.acp ?? true },
            },
          });
        case "session/new": {
          fake.opened.push(params);
          return reply(id, { sessionId: `session-${++sessions}` });
        }
        case "_goose/unstable/session/system-prompt/set":
          fake.prompts.set(sessionId, String(params.text));
          return reply(id, {});
        case "session/prompt": {
          const runId = `run-${fake.turns.length + 1}`;
          const text = (params.prompt as { text: string }[])
            .map((block) => block.text)
            .join("");
          const turn: FakeTurn = {
            sessionId,
            runId,
            text,
            steered: [],
            finish: (stopReason = "end_turn") => {
              if (running.get(sessionId) !== turn) return;
              running.delete(sessionId);
              fake.update(sessionId, {
                sessionUpdate: "session_info_update",
                _meta: { goose: { activeRunId: null } },
              });
              reply(id, { stopReason });
            },
          };
          fake.turns.push(turn);
          running.set(sessionId, turn);
          fake.update(sessionId, {
            sessionUpdate: "session_info_update",
            _meta: { goose: { activeRunId: runId } },
          });
          if (!fake.hold) queueMicrotask(() => turn.finish());
          return;
        }
        case "_goose/unstable/session/steer": {
          const turn = running.get(sessionId);
          if (!turn || turn.runId !== params.expectedRunId)
            return send({
              jsonrpc: "2.0",
              ...(id !== undefined && { id }),
              error: { code: -32602, message: "No active run" },
            });
          turn.steered.push(
            (params.prompt as { text: string }[])
              .map((block) => block.text)
              .join(""),
          );
          return reply(id, { runId: turn.runId, messageId: "m" });
        }
        case "session/cancel":
          fake.cancelled.push(sessionId);
          running.get(sessionId)?.finish("cancelled");
          return;
        case "session/close":
          fake.closed.push(sessionId);
          return reply(id, {});
        default:
          return send({
            jsonrpc: "2.0",
            ...(id !== undefined && { id }),
            error: { code: -32601, message: `Unknown ${method}` },
          });
      }
    };
    let buffer = "";
    return {
      write: async (data) => {
        if (!alive) throw new Error("goose is not running");
        buffer += data;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          handle(JSON.parse(line));
        }
      },
      end: async () => undefined,
      kill: async () => {
        fake.killed = true;
        fake.exit(null);
      },
      exited,
    };
  };
  return {
    spawn,
    processes,
    /** The `goose` processes started, without `workspace` lookups. */
    get geese() {
      return processes.filter((process) => process.id === "goose");
    },
  };
}

/** Lets queued microtasks and the timers they start run. */
export const flush = async (rounds = 10) => {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
};
