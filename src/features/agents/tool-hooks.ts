import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";

/** A mention admitted to a harness session. Tool hooks receive a snapshot,
 * so a send already in flight cannot acknowledge a later mention. */
export type AgentHookMessage = Readonly<{
  id: string;
  channel: string;
  root?: string;
  topLevel?: boolean;
  deliveredAt: number;
}>;
export type AgentToolHookEvent = Readonly<{
  phase: "before" | "after";
  agent: string;
  session: string;
  callId: string;
  tool: string;
  input: Readonly<Record<string, unknown>>;
  messages: readonly AgentHookMessage[];
  /** The tool's default destination when it started. */
  context: Readonly<{ channel?: string; root?: string; topLevel?: boolean }>;
  success?: boolean;
}>;
export type AgentToolHook = Readonly<{
  id: string;
  /** Return a reason to deny a before event. After events are observational.
   * Invoked for every call against the currently active plugin revision. */
  run(
    event: AgentToolHookEvent,
  ): undefined | string | Promise<undefined | string>;
}>;
export type AgentToolHooks = {
  registerToolHook(hook: AgentToolHook): void;
  toolHook(event: AgentToolHookEvent): Promise<string | undefined>;
};

export function createAgentToolHooks(root: Context) {
  const hooks = createContributions<AgentToolHook>(root);
  return {
    register: hooks.register,
    async run(event: AgentToolHookEvent) {
      for (const hook of hooks.snapshot()) {
        try {
          const reason = await hook.run(event);
          if (event.phase === "before" && reason) return reason;
        } catch (error) {
          if (event.phase === "before")
            return `Agent tool hook ${hook.key} failed: ${String(error)}`;
          console.error(`Agent tool hook ${hook.key} failed`, error);
        }
      }
      return undefined;
    },
  };
}

/** Adapts a harness's native pre/post callbacks while retaining the exact
 * pre-call snapshot. Missing post callbacks do not count as successful tools. */
export class ToolHookCallbacks {
  private calls = new Map<string, AgentToolHookEvent>();
  constructor(private readonly run: AgentToolHooks["toolHook"]) {}
  async before(event: Omit<AgentToolHookEvent, "phase">) {
    const snapshot: AgentToolHookEvent = { ...event, phase: "before" };
    const reason = await this.run(snapshot);
    if (!reason) this.calls.set(event.callId, snapshot);
    return reason;
  }
  async after(callId: string, success: boolean) {
    const event = this.calls.get(callId);
    this.calls.delete(callId);
    if (event) await this.run({ ...event, phase: "after", success });
  }
}
