import type { PluginModule } from "../../plugins/api";
import { presented, type AgentPresentation, type AgentType } from "./service";

/** Starts a harness plugin's agent entry, then its UI entry, on `ctx`, and
 * returns the type it registered as the service shows it, with what it
 * presents. Undefined when it registered none. */
export function appliedType<Config>(
  module: Pick<PluginModule, "apply" | "agent">,
  ctx: Readonly<{ agents: object }> & Record<string, unknown>,
): AgentType<Config> | undefined {
  let type: AgentType<Config> | undefined;
  let present: ((exposed: unknown) => AgentPresentation<Config>) | undefined;
  Object.assign(ctx.agents, {
    register: (registered: AgentType<Config>) => {
      type = registered;
    },
    present: (_id: string, shown: typeof present) => {
      present = shown;
    },
  });
  void module.agent?.apply(ctx as never);
  void module.apply(ctx as never);
  return type && present ? presented(type, present(type.expose)) : type;
}
