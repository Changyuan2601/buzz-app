// Foundation Model agents: an agent type whose agents answer with Apple's
// on-device Foundation Model through the `fm` command, so they need no
// provider, key or internet connection. Each turn reads its conversation
// from the community and posts the model's answer as the agent.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
  FmRuntime,
  TURN_MINUTES,
} from "./runtime";
import { createTabs } from "./tabs";

export const TYPE_ID = "fm";

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `fm`; no unusable type elsewhere.
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const runtime = new FmRuntime(host, agents.relay);
  const { Create, SettingsTab } = createTabs(runtime);

  agents.register<Config>({
    id: TYPE_ID,
    title: "Apple Foundation Model",
    description:
      "Apple's on-device model on this Mac. It answers without an internet connection, but can't use tools.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
    }),
    carry: (saved) => {
      const { instructions } = config(saved);
      return instructions.trim() ? { instructions } : {};
    },
    summary: () => "On-device",
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
    ],
    run: (delivery) => runtime.run(delivery),
    timeoutMs: TURN_MINUTES * 60_000,
  });
};
