// The Agents "Mesh" type's runtime: a delivery becomes one inference-only turn
// of the GDK `buzz-agent` helper, spoken to over ACP on stdio. The helper only
// generates text; identity and publishing stay with Agents (`agent.publish`).
//
// Inference comes only from this app's shared compute, through the native
// readiness adapter (`mesh_compute_prepare_inference`). There is no provider
// fallback: if shared compute is not ready the turn fails and says so.
//
// LIMITATION (not isolation): the lease returned with the inference target is
// checked again before publishing so a reply produced across a community switch
// is dropped. That is stale-result mitigation only. A switch can restart
// compute on the same port mid-turn, so the prompt may already have reached the
// newly selected community's mesh, and check→publish is not atomic.
import type { Delivery } from "../../features/agents/service";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";

export type MeshAgentConfig = Readonly<{ prompt: string }>;
export const DEFAULT_PROMPT =
  "You are a helpful assistant in a Buzz community. Answer the latest message directly and concisely. You have no tools; do not claim to have run anything.";
export const DEFAULT_MESH_AGENT_CONFIG: MeshAgentConfig = Object.freeze({
  prompt: DEFAULT_PROMPT,
});
export const meshAgentConfig = (value: unknown): MeshAgentConfig => {
  const prompt =
    value && typeof value === "object"
      ? (value as { prompt?: unknown }).prompt
      : undefined;
  return { prompt: typeof prompt === "string" ? prompt : DEFAULT_PROMPT };
};

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

/** The helper's own provider/credential env is replaced, never inherited, so a
 * developer's shell cannot redirect the agent to another provider. */
const SCRUBBED = [
  "GOOSE_PROVIDER",
  "GOOSE_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_HOST",
  "OPENAI_BASE_PATH",
  "ANTHROPIC_API_KEY",
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_RELAY_URL",
  "BUZZ_AGENT_SYSTEM_PROMPT_FILE",
] as const;

export function helperEnv(
  inference: PreparedInference,
  prompt: string,
): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const key of SCRUBBED) env[key] = null;
  return {
    ...env,
    BUZZ_AGENT_PROVIDER: "relay-mesh",
    BUZZ_AGENT_MODEL: inference.model,
    OPENAI_COMPAT_BASE_URL: inference.baseUrl,
    OPENAI_COMPAT_API_KEY: "mesh-local",
    BUZZ_AGENT_SYSTEM_PROMPT: prompt.trim() || DEFAULT_PROMPT,
    BUZZ_AGENT_NO_HINTS: "1",
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
      // No tools are offered, so any agent→client request is refused.
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

/** Runs one GDK helper turn and returns its reply text. */
export async function generate(
  deps: MeshAgentDeps,
  inference: PreparedInference,
  prompt: string,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  let client: AcpClient | undefined;
  let stderr = "";
  const process = await deps.spawn("agent", {
    cwd: "~/.buzz",
    env: helperEnv(inference, prompt),
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
        `Mesh helper exited (${code ?? "signal"})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
      ),
    ),
  );
  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const session = await client.request<{ sessionId: string }>("session/new", {
      cwd: "/",
      mcpServers: [],
    });
    await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text }],
    });
    return client.text.trim();
  } finally {
    signal.removeEventListener("abort", abort);
    void process.kill();
  }
}

export async function runMeshAgent(
  deps: MeshAgentDeps,
  delivery: Delivery<MeshAgentConfig>,
): Promise<void> {
  const { trigger, agent, channelId, signal } = delivery;
  if (trigger.type === "timer" || !channelId) return;
  const event = trigger.event;
  // Inference-only and spends shared compute: answers its owner only.
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
    const reply = await generate(
      deps,
      inference,
      meshAgentConfig(delivery.config).prompt,
      turnText(event, earlier),
      signal,
    );
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
