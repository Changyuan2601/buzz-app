// The Agents "Mesh" type's runtime: a delivery becomes one turn of lean
// upstream goose (`goose-acp`, bundled as `buzz-mesh-goose`), spoken to over ACP
// on stdio. goose brings its `developer` tools and skills; inference comes only
// from this app's shared compute (`mesh_compute_prepare_inference`), with no
// provider fallback.
//
// Replies, per agent (`reply`):
// - "tools": like the Codex and Claude Code types, the model gets the shared
//   Buzz tools `send` and `read` (`buzz-mcp/tools.ts`), executed here through
//   `appClient` so Agents' host signer signs as the agent; goose never holds a
//   key. A turn that never calls `send` still has its text posted.
// - "direct": the plugin posts goose's final text as the reply.
//
// Bridge: goose only spawns stdio MCP servers, so the plugin declares
// `nc -U <socket>` as the `buzz` server and holds the other end itself through a
// declared `nc -lU <socket>` process. macOS only; the socket lives under /tmp
// for the turn.
//
// LIMITATION (not isolation): the lease returned with the inference target is
// checked again before publishing so a reply produced across a community switch
// is dropped. That is stale-result mitigation only. A switch can restart
// compute on the same port mid-turn, so the prompt may already have reached the
// newly selected community's mesh, and check→publish is not atomic. Tool calls
// (`send`) made before such a switch are not undone.
import type { Delivery } from "../../features/agents/service";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import { appClient } from "../../buzz-mcp/app-client";
import type { Context } from "../../buzz-mcp/client";
import { BUZZ_PROMPT } from "../../buzz-mcp/prompt";
import { respond } from "../../buzz-mcp/rpc";
import { TOOLS } from "../../buzz-mcp/tools";

export type ReplyMode = "tools" | "direct";
export type MeshAgentConfig = Readonly<{
  prompt: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether the model replies with the Buzz `send` tool, or the plugin posts
   * its final text. */
  reply: ReplyMode;
}>;
export const DEFAULT_PROMPT =
  "You are a helpful assistant in a Buzz community. Answer the latest message directly and concisely. Use your tools when the request needs them, and never claim to have run something you did not.";
export const DEFAULT_WORKSPACE = "~/.buzz";
export const DEFAULT_MESH_AGENT_CONFIG: MeshAgentConfig = Object.freeze({
  prompt: DEFAULT_PROMPT,
  workspace: DEFAULT_WORKSPACE,
  reply: "tools",
});
export const absoluteWorkspace = (path: string) =>
  path.trim().startsWith("/") || /^[A-Za-z]:[\\/]/.test(path.trim());
export const validWorkspace = (path: string) =>
  path.trim() === DEFAULT_WORKSPACE || absoluteWorkspace(path);
export const meshAgentConfig = (value: unknown): MeshAgentConfig => {
  const raw =
    value && typeof value === "object"
      ? (value as { prompt?: unknown; workspace?: unknown; reply?: unknown })
      : {};
  return {
    prompt: typeof raw.prompt === "string" ? raw.prompt : DEFAULT_PROMPT,
    workspace:
      typeof raw.workspace === "string" && validWorkspace(raw.workspace)
        ? raw.workspace.trim()
        : DEFAULT_WORKSPACE,
    reply: raw.reply === "direct" ? "direct" : "tools",
  };
};

/** The Buzz tools a Mesh agent gets; the rest of `TOOLS` stay unexposed. */
export const BUZZ_TOOLS = new Set(["send", "read"]);
/** Where goose keeps its own config, sessions and state for Mesh agents. */
const GOOSE_ROOT = "~/.local/share/buzz-mesh-goose";

export type PreparedInference = Readonly<{
  baseUrl: string;
  model: string;
  lease: string;
}>;
export type MeshAgentDeps = Readonly<{
  spawn(id: string, options?: HostProcessOptions): Promise<HostProcess>;
  prepare(origin: string): Promise<PreparedInference>;
  current(lease: string): Promise<boolean>;
  /** The foreground community origin; the turn's inference is prepared for it. */
  origin(): string | undefined;
  /** Earlier messages of the conversation, oldest first; best effort. */
  history?(delivery: Delivery<MeshAgentConfig>): Promise<readonly EventData[]>;
}>;

/** Provider, credential and Buzz identity variables a developer's shell might
 * carry are removed, never inherited, so the agent can only reach this
 * community's shared compute and never holds a Buzz key. */
const SCRUBBED = [
  "GOOSE_PROVIDER",
  "GOOSE_MODEL",
  "GOOSE_MODE",
  "GOOSE_PATH_ROOT",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_HOST",
  "OPENAI_BASE_PATH",
  "ANTHROPIC_API_KEY",
  "DATABRICKS_HOST",
  "DATABRICKS_TOKEN",
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_RELAY_URL",
] as const;

/** goose platform extensions switched off: the agent keeps `developer` and
 * skills, but cannot install extensions or delegate to subagents. */
const DISABLED_EXTENSIONS = ["extensionmanager", "summon"] as const;

/** Environment for `goose-acp`: goose's OpenAI-compatible provider pointed at
 * the prepared shared-compute endpoint, with goose's own state kept in
 * `root` rather than the user's goose configuration and sessions. */
export function gooseEnv(
  inference: PreparedInference,
  root: string,
): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const key of SCRUBBED) env[key] = null;
  const url = new URL(inference.baseUrl);
  const base = url.pathname.replace(/^\/+|\/+$/g, "");
  return {
    ...env,
    GOOSE_PROVIDER: "openai",
    GOOSE_MODEL: inference.model,
    OPENAI_HOST: url.origin,
    OPENAI_BASE_PATH: `${base ? `${base}/` : ""}chat/completions`,
    OPENAI_API_KEY: "mesh-local",
    GOOSE_MODE: "auto",
    GOOSE_PATH_ROOT: root,
    GOOSE_DISABLE_SESSION_NAMING: "true",
    EXTENSIONS: JSON.stringify(
      Object.fromEntries(
        DISABLED_EXTENSIONS.map((name) => [
          name,
          {
            enabled: false,
            type: "platform",
            name,
            description: name,
            bundled: true,
          },
        ]),
      ),
    ),
  };
}

/** A minimal ACP client over newline-delimited JSON-RPC. */
export class AcpClient {
  private buffer = "";
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  text = "";

  constructor(private readonly write: (line: string) => Promise<void>) {}

  receive(chunk: string) {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handle(line);
      index = this.buffer.indexOf("\n");
    }
  }

  fail(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private handle(line: string) {
    let message: {
      id?: number;
      method?: string;
      params?: {
        update?: {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
      };
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "session/update") {
      const update = message.params?.update;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      )
        this.text += update.content.text ?? "";
      return;
    }
    if (message.method && message.id !== undefined) {
      // The client offers no ACP capabilities, so any agent→client request is refused.
      void this.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported" } })}\n`,
      );
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error)
      waiter.reject(new Error(message.error.message ?? "ACP error"));
    else waiter.resolve(message.result);
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      ).catch((error) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

const label = (event: EventData) => event.pubkey.slice(0, 8);
export function turnText(
  event: EventData,
  earlier: readonly EventData[],
): string {
  const lines = earlier.map((item) => `[${label(item)}] ${item.content}`);
  return [
    ...(lines.length ? ["Earlier in this conversation:", ...lines, ""] : []),
    `Latest message from [${label(event)}]:`,
    event.content,
  ].join("\n");
}

/** The helper needs an absolute working directory; `~/…` is resolved by the
 * host (it expands `cwd`) and read back with `pwd`. */
export async function resolveWorkspace(
  deps: Pick<MeshAgentDeps, "spawn">,
  path: string,
): Promise<string> {
  if (absoluteWorkspace(path)) return path.trim();
  let directory = "";
  const process = await deps.spawn("workspace", {
    cwd: path,
    onStdout: (data) => {
      directory += data;
    },
  });
  const code = await process.exited;
  const workspace = directory.trim();
  if (code !== 0 || !absoluteWorkspace(workspace))
    throw new Error(`Could not resolve the agent workspace ${path}`);
  return workspace;
}

type Message = Readonly<{
  id?: string | number | null;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
}>;
export type TurnTools = Readonly<{
  /** Answers one MCP message from goose; undefined for notifications. */
  serve(message: Message): Promise<object | undefined>;
  /** Set once the model has called `send` with `final: true`. */
  finished(): boolean;
  /** Whether the model posted anything with `send`. */
  sent(): boolean;
}>;

/** The Buzz tools for one turn, as an MCP server limited to `BUZZ_TOOLS`. */
export function turnTools(
  delivery: Delivery<MeshAgentConfig>,
  deps: Pick<MeshAgentDeps, "spawn">,
  cwd: string,
  context: Context,
): TurnTools {
  let sent = false;
  let finished = false;
  const client = appClient(delivery.agent, {
    spawn: deps.spawn,
    cwd,
    memories: async () => [],
    signal: delivery.signal,
  });
  return {
    sent: () => sent,
    finished: () => finished,
    async serve(message) {
      const { id, method, params = {} } = message;
      if (id === undefined || id === null) return undefined;
      if (method === "tools/list")
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS.filter((tool) => BUZZ_TOOLS.has(tool.name)) },
        };
      const name = String(params.name);
      if (method === "tools/call" && !BUZZ_TOOLS.has(name))
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `No tool ${name}` }],
            isError: true,
          },
        };
      const reply = (await respond(client, context, message)) as {
        result?: { isError?: boolean };
      };
      if (
        method === "tools/call" &&
        name === "send" &&
        !reply.result?.isError
      ) {
        sent = true;
        if (
          (params.arguments as { final?: unknown } | undefined)?.final === true
        )
          finished = true;
      }
      return reply;
    },
  };
}

/** Holds the plugin's end of the `buzz` MCP bridge: a declared `nc -lU`
 * process whose stdio carries goose's MCP messages. */
async function openBridge(
  deps: Pick<MeshAgentDeps, "spawn">,
  tools: TurnTools,
): Promise<{ server: object; close(): void }> {
  const socket = `/tmp/buzz-mesh-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}.sock`;
  let buffer = "";
  let bridge: HostProcess | undefined;
  const handle = (line: string) => {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void tools
      .serve(message)
      .then((reply) => reply && bridge?.write(`${JSON.stringify(reply)}\n`))
      .catch(() => {});
  };
  bridge = await deps.spawn("bridge", {
    args: [socket],
    onStdout: (data) => {
      buffer += data;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handle(line);
        index = buffer.indexOf("\n");
      }
    },
  });
  // goose connects when the session starts; let the listener bind first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    server: { name: "buzz", command: "nc", args: ["-U", socket], env: [] },
    close: () => void bridge?.kill(),
  };
}

/** Runs one goose turn and returns its final text. */
export async function generate(
  deps: MeshAgentDeps,
  inference: PreparedInference,
  instructions: string,
  text: string,
  signal: AbortSignal,
  cwd: string,
  tools?: TurnTools,
): Promise<string> {
  let client: AcpClient | undefined;
  let stderr = "";
  const root = await resolveWorkspace(deps, GOOSE_ROOT);
  const bridge = tools ? await openBridge(deps, tools) : undefined;
  try {
    const process = await deps.spawn("agent", {
      cwd,
      env: gooseEnv(inference, root),
      onStdout: (data) => client?.receive(data),
      onStderr: (data) => {
        stderr = (stderr + data).slice(-2000);
      },
    });
    client = new AcpClient((line) => process.write(line));
    const abort = () => void process.kill();
    signal.addEventListener("abort", abort, { once: true });
    void process.exited.then((code) =>
      client?.fail(
        new Error(
          `goose exited (${code ?? "signal"})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
        ),
      ),
    );
    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const session = await client.request<{ sessionId: string }>(
        "session/new",
        { cwd, mcpServers: bridge ? [bridge.server] : [] },
      );
      await client.request("_goose/unstable/session/system-prompt/set", {
        sessionId: session.sessionId,
        mode: "append",
        key: "buzz",
        text: instructions,
      });
      // A final `send` ends the turn, as for Codex and Claude Code.
      const watch = setInterval(() => {
        if (tools?.finished()) {
          clearInterval(watch);
          void client?.notify("session/cancel", {
            sessionId: session.sessionId,
          });
        }
      }, 250);
      try {
        await client.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text }],
        });
      } finally {
        clearInterval(watch);
      }
      return client.text.trim();
    } finally {
      signal.removeEventListener("abort", abort);
      void process.kill();
    }
  } finally {
    bridge?.close();
  }
}

/** The appended system prompt: Buzz's shared guidance when the model replies
 * with tools, then the agent's own prompt. */
export function instructions(config: MeshAgentConfig): string {
  const prompt = config.prompt.trim() || DEFAULT_PROMPT;
  if (config.reply === "direct") return prompt;
  return `${BUZZ_PROMPT}

You can use only the Buzz tools \`send\` and \`read\`. Reply with \`send\`, and pass \`final: true\` on your last message of the turn.

<agent-instructions>
${prompt}
</agent-instructions>`;
}

export async function runMeshAgent(
  deps: MeshAgentDeps,
  delivery: Delivery<MeshAgentConfig>,
): Promise<void> {
  const { trigger, agent, channelId, signal } = delivery;
  if (trigger.type === "timer" || !channelId) return;
  const event = trigger.event;
  // Spends shared compute and runs tools on this machine: answers its owner only.
  if (event.pubkey !== agent.owner || event.pubkey === agent.pubkey) return;
  const root = threadReference(event)?.rootId ?? event.id;
  const tags = [
    ["h", channelId],
    ...(root === event.id ? [] : [["e", root, "", "root"]]),
    ["e", event.id, "", "reply"],
    ["p", event.pubkey],
  ];
  let content: string;
  try {
    const origin = deps.origin();
    if (!origin) throw new Error("No community is connected");
    const inference = await deps.prepare(origin);
    const earlier = (await deps.history?.(delivery).catch(() => [])) ?? [];
    const config = meshAgentConfig(delivery.config);
    const cwd = await resolveWorkspace(deps, config.workspace);
    const tools =
      config.reply === "tools"
        ? turnTools(delivery, deps, cwd, { channel: channelId, root })
        : undefined;
    const reply = await generate(
      deps,
      inference,
      instructions(config),
      turnText(event, earlier),
      signal,
      cwd,
      tools,
    );
    // The model already answered through `send`.
    if (tools?.sent()) return;
    if (!reply) throw new Error("The mesh model returned no text");
    // Stale-result mitigation only; see the module comment.
    if (!(await deps.current(inference.lease))) {
      console.warn("Mesh agent reply dropped: community changed mid-turn");
      return;
    }
    content = reply;
  } catch (error) {
    if (signal.aborted) return;
    const reason = error instanceof Error ? error.message : String(error);
    content = `⚠️ Mesh agent couldn't answer: ${reason.slice(0, 500)}`;
  }
  await agent.publish({ kind: 9, content, tags });
}
