// The Pi host (host.mjs): one process for every Pi agent here, started when
// something needs it, spoken to over stdio, one JSON message a line. Requests
// go both ways: the plugin asks the host to run turns, and the host asks the
// plugin to run the Buzz tools, so the process holds no Buzz key, and for the
// providers Buzz shares.
import type { Context } from "../../buzz-mcp/client";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import packageJson from "./deps/package.json?raw";
import packageLock from "./deps/package-lock.json?raw";
import host from "./host.mjs?raw";
import script from "./pi.sh?raw";

type Spawn = (id: string, options?: HostProcessOptions) => Promise<HostProcess>;

export type ToolCall = Readonly<{
  agent: string;
  /** The Pi conversation whose run called. */
  conversation: number;
  /** Where the tools default to for that conversation. */
  context: Context;
  name: string;
  arguments: Record<string, unknown>;
}>;
/** An MCP tool result; `final` ends the run that called it. */
export type ToolResult = Readonly<{
  content: readonly unknown[];
  isError?: boolean;
  final?: boolean;
}>;
export type PiEvent = Readonly<
  { agent: string; conversation: number } & (
    | { type: "placed"; request: string }
    | { type: "step"; tool: string; target?: string }
  )
>;
/** A provider Buzz shares, with each model's route; the host gets access
 * tokens by running `command`. Empty for one Buzz doesn't share. */
export type Binding =
  | Readonly<{
      name: string;
      command: string;
      args: readonly string[];
      models: readonly Readonly<{
        id: string;
        name: string;
        api: "openai-responses" | "anthropic-messages";
        baseUrl: string;
      }>[];
    }>
  | Readonly<Record<string, never>>;
type Handlers = Readonly<{
  tool(call: ToolCall): Promise<ToolResult>;
  event(event: PiEvent): void;
  provider(id: string): Promise<Binding>;
}>;

/** The host stopped after it started; its runs continue in the next one. */
export class PiStopped extends Error {}

/** What the host's stderr says last, for an error that names a cause. */
const TAIL = 2_000;
/** How long a stopping host has to close each agent's storage. */
const STOP_MS = 2_000;

type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
};
type Connection = {
  process: HostProcess;
  calls: Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >;
  /** Set once it has exited, with why. */
  gone?: Error;
};

export class Pi {
  private connection: Promise<Connection> | undefined;
  private requests = 0;
  private stopped = false;

  constructor(
    private readonly spawn: () => Spawn,
    private readonly handlers: Handlers,
  ) {}

  /** Asks the host, starting it first if it is not running. */
  async request<T>(method: string, params: object = {}): Promise<T> {
    const connection = await this.connect();
    if (connection.gone) throw connection.gone;
    const id = ++this.requests;
    const answer = new Promise<unknown>((resolve, reject) =>
      connection.calls.set(id, { resolve, reject }),
    );
    void connection.process
      .write(`${JSON.stringify({ id, method, params })}\n`)
      .catch((error: unknown) => {
        connection.calls
          .get(id)
          ?.reject(new Error(`Pi did not take that: ${error}`));
        connection.calls.delete(id);
      });
    return answer as Promise<T>;
  }

  /** Stops the host: it closes each agent's storage, then it is killed. */
  async dispose() {
    this.stopped = true;
    const connection = await this.connection?.catch(() => undefined);
    if (!connection || connection.gone) return;
    await connection.process.end().catch(() => undefined);
    const timer = setTimeout(() => void connection.process.kill(), STOP_MS);
    await connection.process.exited;
    clearTimeout(timer);
  }

  private connect(): Promise<Connection> {
    if (this.stopped) return Promise.reject(new Error("Pi has stopped"));
    if (!this.connection) {
      const connecting = this.start();
      this.connection = connecting;
      // One that failed to start is tried again by the next request.
      connecting.catch(() => {
        if (this.connection === connecting) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private async start(): Promise<Connection> {
    let ready!: () => void;
    let isReady = false;
    const started = new Promise<void>((resolve) => {
      ready = () => {
        isReady = true;
        resolve();
      };
    });
    let buffer = "";
    let stderr = "";
    const connection: Connection = {
      calls: new Map(),
      process: undefined as unknown as HostProcess,
    };
    const handle = (message: Message) => {
      if (message.method === "ready") ready();
      else if (message.method === "event")
        this.handlers.event(message.params as PiEvent);
      else if (message.method === "tool" && message.id !== undefined)
        void this.answer(connection, message.id, () =>
          this.handlers.tool(message.params as ToolCall),
        );
      else if (message.method === "provider" && message.id !== undefined)
        void this.answer(connection, message.id, () =>
          this.handlers.provider((message.params as { id: string }).id),
        );
      else if (typeof message.id === "number") {
        const call = connection.calls.get(message.id);
        connection.calls.delete(message.id);
        if (message.error) call?.reject(new Error(message.error));
        else call?.resolve(message.result);
      }
    };
    connection.process = await this.spawn()("pi-sh", {
      args: [script, "pi.sh", host, packageJson, packageLock],
      cwd: "~",
      onStdout: (data) => {
        buffer += data;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          try {
            handle(JSON.parse(line));
          } catch (error) {
            console.warn("Pi sent a message Buzz could not read", error);
          }
        }
      },
      onStderr: (data) => {
        stderr = (stderr + data).slice(-TAIL);
      },
    });
    void connection.process.exited.then((code) => {
      // Before it is ready, its last words are why it could not start, such
      // as Node missing.
      const why = stderr.trim().split("\n").at(-1);
      const exit = `exit ${code ?? "signal"}`;
      connection.gone = isReady
        ? new PiStopped(why ? `Pi stopped: ${why}` : `Pi stopped (${exit})`)
        : new Error(why ?? `Pi could not start (${exit})`);
      for (const call of connection.calls.values())
        call.reject(connection.gone);
      connection.calls.clear();
      // The next request starts another.
      this.connection = undefined;
      ready();
    });
    await started;
    if (connection.gone) throw connection.gone;
    return connection;
  }

  /** Answers what the host asked, such as to run a Buzz tool. */
  private async answer(
    connection: Connection,
    id: number | string,
    run: () => Promise<unknown>,
  ) {
    let message: Message;
    try {
      message = { id, result: await run() };
    } catch (error) {
      message = {
        id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!connection.gone)
      await connection.process
        .write(`${JSON.stringify(message)}\n`)
        .catch(() => undefined);
  }
}
