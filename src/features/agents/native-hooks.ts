import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";

/** Native hooks.json event tables. Event names and entries belong to the harness. */
export type NativeHookConfig = Readonly<Record<string, readonly unknown[]>>;
export type AgentNativeHooks = Readonly<{
  id: string;
  harness: "claude-code" | "codex";
  hooks: NativeHookConfig;
}>;

const containsNull = (value: unknown): boolean =>
  value === null ||
  (typeof value === "object" && Object.values(value).some(containsNull));

/** Trusted plugin code can install native commands with the agent's privileges,
 * just as it can contribute agent tools. This is not a host process sandbox. */
export function createAgentNativeHooks(root: Context) {
  const contributions = createContributions<AgentNativeHooks>(root);
  return {
    subscribe: contributions.subscribe,
    register(ctx: Context, value: AgentNativeHooks) {
      const hooks = JSON.parse(JSON.stringify(value.hooks)) as NativeHookConfig;
      if (
        !hooks ||
        Array.isArray(hooks) ||
        typeof hooks !== "object" ||
        Object.values(hooks).some((entries) => !Array.isArray(entries))
      )
        throw new Error(
          "Native hook configuration must map event names to arrays",
        );
      if (value.harness === "codex" && containsNull(hooks))
        throw new Error(
          "Codex hook configuration cannot contain null TOML values",
        );
      contributions.register(ctx, { ...value, hooks });
    },
    config(harness: AgentNativeHooks["harness"]): NativeHookConfig {
      const hooks = new Map<string, unknown[]>();
      for (const entry of [...contributions.snapshot()].sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        if (entry.harness !== harness) continue;
        for (const [name, values] of Object.entries(entry.hooks))
          hooks.set(name, [...(hooks.get(name) ?? []), ...values]);
      }
      return Object.fromEntries(hooks);
    },
  };
}
