import { withTimeout } from "../../plugins/timeout";
import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";

/** Trusted routing supplied by the harness adapter, never by hook input. */
export type AgentHookContext = Readonly<{
  agent: string;
  session: string;
}>;
/** Event names, input and output formats belong to the selected agent type. */
export type AgentHook = Readonly<{
  id: string;
  harness: string;
  event: string;
  run(input: unknown, context: AgentHookContext): unknown | Promise<unknown>;
}>;

export function createAgentHooks(root: Context) {
  const contributions = createContributions<AgentHook>(root);
  return {
    register(ctx: Context, hook: AgentHook) {
      if (!ctx.pluginOwner?.agentHooks?.includes(hook.harness))
        throw new Error(`Declare host.agentHooks access for ${hook.harness}`);
      if (!hook.event.trim() || typeof hook.run !== "function")
        throw new Error("A hook needs an event and callback");
      contributions.register(ctx, {
        ...hook,
        run: (input, context) =>
          withTimeout(
            Promise.resolve().then(() => hook.run(input, context)),
            `Hook ${hook.id} timed out`,
            30_000,
          ),
      });
    },
    /** Adapters compose results in their own native format. Look up handlers on
     * every event so enabling or removing a plugin needs no process restart. */
    handlers(harness: string, event: string) {
      return contributions
        .snapshot()
        .filter((hook) => hook.harness === harness && hook.event === event)
        .sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
