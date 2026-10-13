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
  deleted: string[];
  /** The environment it started with. */
  env: Readonly<Record<string, string | null>>;
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

/** A session goose saved, with its messages as goose exports them. */
export type FakeSession = Readonly<{
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  conversation: readonly Record<string, unknown>[];
}>;

/** A spawn whose `goose` processes answer like `goose-acp`, and whose
 * `workspace` process prints `home` for a `~/…` directory. */
export function fakeSpawn(
  options: Readonly<{
    acp?: boolean;
    home?: string;
    hold?: boolean;
    /** What a turn writes before it ends. */
    reply?: string;
    /** `providers/list` entries, and goose's default provider and model. */
    providers?: readonly Record<string, unknown>[];
    defaults?: Readonly<{ providerId?: string; modelId?: string }>;
    /** Provider fields saved, by provider; `config/save` adds to it. */
    saved?: Map<string, Set<string>>;
    /** What `supported-models/list` returns. */
    supported?: readonly string[];
    /** Saved sessions `session/list` and `session/export` read. */
    history?: readonly FakeSession[];
  }> = {},
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
      deleted: [],
      env: process.env ?? {},
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
          if (options.reply)
            fake.update(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: options.reply },
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
        case "_goose/unstable/providers/list":
          // Saving a provider's fields sets it up, as goose lists it after.
          return reply(id, {
            entries: (options.providers ?? []).map((entry) => ({
              ...entry,
              configured:
                Boolean(entry.configured) ||
                Boolean(options.saved?.get(String(entry.providerId))?.size),
            })),
          });
        case "_goose/unstable/defaults/read":
          return reply(id, options.defaults ?? {});
        case "_goose/unstable/providers/config/read": {
          const set = options.saved?.get(String(params.providerId));
          return reply(id, {
            fields: [...(set ?? [])].map((key) => ({ key, isSet: true })),
          });
        }
        case "_goose/unstable/providers/config/save": {
          const providerId = String(params.providerId);
          const set = options.saved?.get(providerId) ?? new Set<string>();
          for (const field of params.fields as { key: string }[])
            set.add(field.key);
          options.saved?.set(providerId, set);
          return reply(id, { status: { providerId, isConfigured: true } });
        }
        case "_goose/unstable/providers/supported-models/list":
          return reply(id, {
            providerId: params.providerId,
            models: options.supported ?? [],
          });
        case "session/list": {
          const query = String(
            (params._meta as { query?: string } | undefined)?.query ?? "",
          );
          const mentions = (session: FakeSession) =>
            JSON.stringify(session.conversation).includes(query);
          return reply(id, {
            sessions: (options.history ?? [])
              .filter(
                (session) =>
                  session.cwd === params.cwd && (!query || mentions(session)),
              )
              .map(({ sessionId, title, cwd, updatedAt }) => ({
                sessionId,
                title,
                cwd,
                updatedAt,
              })),
          });
        }
        case "_goose/unstable/session/export": {
          const session = options.history?.find(
            (item) => item.sessionId === params.sessionId,
          );
          if (!session)
            return send({
              jsonrpc: "2.0",
              ...(id !== undefined && { id }),
              error: { code: -32603, message: "Session not found" },
            });
          return reply(id, {
            data: JSON.stringify({ id: session.sessionId, ...session }),
          });
        }
        case "session/delete":
          fake.deleted.push(sessionId);
          return reply(id, {});
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
