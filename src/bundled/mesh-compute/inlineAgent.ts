// Tauri callback adapter only. Rust owns inference and tool sequencing.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Delivery, AgentHandle } from "../../features/agents/service";
import { appClient } from "../../buzz-mcp/app-client";
import type { Context } from "../../buzz-mcp/client";
import { callTool, TOOLS } from "../../buzz-mcp/tools";
import { content, errorText } from "../../buzz-mcp/rpc";
import type {
  MeshAgentConfig,
  MeshAgentDeps,
  PreparedInference,
} from "./meshAgent";
import {
  gooseTurns,
  type MeshHistoryRow,
  type GooseTranscript,
} from "./meshTranscript";

type Message = Parameters<typeof gooseTurns>[0][number];
const ALLOWED = new Set(TOOLS.map((tool) => tool.name));
export const INLINE_TOOLS = TOOLS.map((tool) => {
  const properties = { ...tool.inputSchema.properties };
  if (tool.name === "send") delete properties.final;
  return {
    ...tool,
    name: `buzz_${tool.name}`,
    inputSchema: { ...tool.inputSchema, properties },
    description:
      tool.name === "send"
        ? `${tool.description} Optional update: final prose is posted automatically. This does not end the turn.`
        : tool.description,
  };
});
type Frame =
  | { type: "ready"; run: string }
  | {
      type: "tool";
      run: string;
      id: number;
      call: { name: string; arguments?: Record<string, unknown> };
    }
  | { type: "message"; run: string; message: Message };
type Saved = {
  agent: string;
  workspace: string;
  row: MeshHistoryRow;
  messages: Message[];
};
export type InlineTurn = {
  delivery: Delivery<MeshAgentConfig>;
  inference: PreparedInference;
  cwd: string;
  context: Context;
  sessionKey: string;
  system: string;
  prompt: string;
};

/** Session-only transcripts. No helper process or persisted Goose session database. */
export class InlineAgent {
  private saved = new Map<string, Saved>();
  private active = new Set<AbortController>();
  constructor(
    private readonly deps: Pick<
      MeshAgentDeps,
      "spawn" | "current" | "memories" | "remembered"
    >,
  ) {}
  dispose() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.saved.clear();
  }
  async run(input: InlineTurn): Promise<{ text: string }> {
    const { delivery, inference, cwd, context, system, prompt } = input;
    const controller = new AbortController();
    this.active.add(controller);
    const signal = AbortSignal.any([delivery.signal, controller.signal]);
    const id = crypto.randomUUID();
    const check = async () => {
      signal.throwIfAborted();
      if (delivery.current && !delivery.current())
        throw new Error("Agent turn ended");
      if (!(await this.deps.current(inference.lease)))
        throw new Error("Mesh selection retired");
      signal.throwIfAborted();
    };
    const cancel = () => {
      void invoke("mesh_compute_agent_cancel", {
        id,
        agent: delivery.agent.pubkey,
      }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const guarded: AgentHandle = {
      ...delivery.agent,
      publish: async (event) => {
        await check();
        return delivery.agent.publish(event);
      },
      query: async (filters) => {
        await check();
        return delivery.agent.query(filters);
      },
      upload: async (data, mime) => {
        await check();
        return delivery.agent.upload(data, mime);
      },
      media: async (url) => {
        await check();
        return delivery.agent.media(url);
      },
      remember: async (slug, body, after) => {
        await check();
        return delivery.agent.remember(slug, body, after);
      },
    };
    const client = appClient(guarded, {
      spawn: this.deps.spawn,
      cwd,
      signal,
      check: () => {
        if (delivery.current && !delivery.current())
          throw new Error("Agent turn ended");
      },
      memories: () =>
        this.deps.memories?.(delivery.agent.pubkey, signal) ??
        Promise.resolve([]),
      remembered: () => this.deps.remembered?.(delivery.agent.pubkey),
    });
    // Each turn is rebuilt from relay conversation. Keep partial tool evidence for inspection,
    // not replay: a cancelled send might already have reached the relay.
    const messages: Message[] = [
      {
        role: "user",
        created: Math.floor(Date.now() / 1000),
        content: [{ type: "text", text: prompt }],
      },
    ];
    const saved: Saved = {
      agent: delivery.agent.pubkey,
      workspace: cwd,
      row: {
        sessionId: id,
        title: "Rust/GDK trial (this app session)",
        at: Date.now(),
        channelId: context.channel ?? "",
        ...(context.root ? { root: context.root } : {}),
      },
      messages: [...messages],
    };
    this.saved.set(id, saved);
    for (const oldest of this.saved.keys()) {
      if (this.saved.size <= 50) break;
      this.saved.delete(oldest);
    }
    const pending = new Set<Promise<void>>();
    const events = new Channel<Frame>();
    events.onmessage = (frame) => {
      if (frame.run !== id) return;
      if (signal.aborted) {
        cancel();
        return;
      }
      if (frame.type === "message") {
        saved.messages.push(frame.message);
        return;
      }
      if (frame.type !== "tool") return;
      const task = (async () => {
        let result: { content: ReturnType<typeof content>; isError?: boolean };
        try {
          await check();
          const name = frame.call.name.startsWith("buzz_")
            ? frame.call.name.slice(5)
            : "";
          if (!delivery.config.buzz || !ALLOWED.has(name))
            throw new Error("Tool is not permitted");
          result = {
            content: content(
              await callTool(client, context, name, frame.call.arguments ?? {}),
            ),
          };
        } catch (error) {
          result = {
            content: [{ type: "text", text: errorText(error) }],
            isError: true,
          };
        }
        if (
          new TextEncoder().encode(JSON.stringify(result)).byteLength >
          32 * 1024
        ) {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: "Tool completed but the result exceeded 32 KiB. Effects are not rolled back. Do not repeat sends or writes; retrieve a smaller page using limit/before or a narrower search.",
              },
            ],
          };
        }
        await invoke("mesh_compute_agent_result", {
          id,
          agent: delivery.agent.pubkey,
          call: frame.id,
          result,
        }).catch(() => {
          controller.abort();
        });
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    };
    try {
      await check();
      const text = await invoke<string>("mesh_compute_agent_run", {
        request: {
          id,
          agent: delivery.agent.pubkey,
          lease: inference.lease,
          model: inference.model,
          workspace: cwd,
          system: delivery.config.buzz
            ? `${system}

All shared Buzz tools are available with a buzz_ prefix. Instructions referring to mem_set mean buzz_mem_set. Use buzz_read with a small limit, explicit channel and before for older channel pages, or a narrower search, to retrieve exact context when needed.`
            : system,
          messages: messages.map((message) => ({
            ...message,
            metadata: { userVisible: true, agentVisible: true },
          })),
          tools: delivery.config.buzz ? INLINE_TOOLS : [],
        },
        events,
      });
      await check();
      return { text };
    } catch (error) {
      saved.messages.push({
        role: "assistant",
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: "text",
            text: `Turn ended: ${errorText(error)}. Earlier tool effects may have occurred; do not assume they were rolled back.`,
          },
        ],
      });
      throw error;
    } finally {
      controller.abort();
      await Promise.all(pending);
      signal.removeEventListener("abort", cancel);
      this.active.delete(controller);
    }
  }
  async recent(agent: string, _workspace: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return [...this.saved.values()]
      .filter((s) => s.agent === agent)
      .map((s) => s.row)
      .sort((a, b) => b.at - a.at);
  }
  async transcript(
    agent: string,
    _workspace: string,
    row: MeshHistoryRow,
    signal: AbortSignal,
  ): Promise<GooseTranscript> {
    signal.throwIfAborted();
    const saved = this.saved.get(row.sessionId);
    if (!saved || saved.agent !== agent)
      throw new Error("This session transcript is no longer available");
    return {
      turns: gooseTurns(saved.messages, row, true),
      unknownThread: 0,
      more: false,
    };
  }
}
