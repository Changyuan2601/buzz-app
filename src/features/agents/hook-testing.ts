import type {
  AgentHookMessage,
  AgentHookEvent,
  HookOutput,
  RegisteredAgentHook,
} from "./hooks";
export type PolicyEvent = Readonly<{
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

export type Policy = (
  event: PolicyEvent,
) => undefined | string | Promise<undefined | string>;
export function policyCallbacks(
  harness: AgentHookEvent["harness"],
): RegisteredAgentHook[] {
  return ["PreToolUse", "PostToolUse", "PostToolUseFailure"].map(
    (event, index) => ({
      id: String(index),
      key: `policy/${index}`,
      pluginId: "policy",
      revision: "one",
      harness,
      event,
      ...(harness === "codex" && index ? { source: "host" as const } : {}),
      input: Object.fromEntries(
        ["session_id", "turn_id", "tool_use_id", "tool_name", "tool_input"].map(
          (key) => [key, `\${${key}}`],
        ),
      ),
      run: () => ({}),
    }),
  );
}
export function policyAdapter(run: Policy) {
  const calls = new Map<string, PolicyEvent>();
  return async (_key: string, event: AgentHookEvent): Promise<HookOutput> => {
    const input = event.input;
    const callId = String(input.tool_use_id ?? "");
    const before = event.event === "PreToolUse";
    const tool = String(input.tool_name ?? "");
    const snapshot: PolicyEvent = {
      agent: event.agent,
      session: event.session,
      phase: "before",
      callId,
      tool: tool.startsWith("buzz") ? `mcp__buzz__${tool.slice(4)}` : tool,
      input: (input.tool_input ?? {}) as Record<string, unknown>,
      messages: event.messages,
      context: event.context,
    };
    const value = before
      ? snapshot
      : {
          ...(calls.get(callId) ?? snapshot),
          phase: "after" as const,
          success: event.event === "PostToolUse",
        };
    const reason = await run(value);
    if (before && !reason) calls.set(callId, snapshot);
    if (!before) calls.delete(callId);
    return !reason
      ? {}
      : event.harness === "codex"
        ? { decision: "block", reason }
        : {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          };
  };
}
