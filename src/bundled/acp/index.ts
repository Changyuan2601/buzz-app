// ACP agents: an agent type for any harness that speaks the Agent Client
// Protocol, started from a preset or a command the owner types and confirms.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import {
  adopt,
  carry,
  type Config,
  config,
  DEFAULT_CONFIG,
  launch,
} from "./config";
import { preset } from "./presets";
import { createTabs } from "./tabs";

export const TYPE_ID = "acp";

export const inject = ["agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!isTauri()) return;
  const { SettingsTab, HistoryTab } = createTabs({
    // Until the runtime lands, Check verifies only what launch would refuse.
    check: async (value) => {
      const found = await launch(value);
      return "error" in found
        ? found.error
        : "The settings are valid. Starting the harness to check it isn't available yet.";
    },
  });
  ctx.agents.register<Config>({
    id: TYPE_ID,
    title: "ACP agent",
    description:
      "Any harness that speaks the Agent Client Protocol, from a preset or a command you confirm.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    adopt,
    carry,
    summary: (agent) => {
      const value = config(agent.config);
      return preset(value.preset)?.title ?? (value.command || "ACP agent");
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: SettingsTab,
      },
      {
        id: "history",
        title: "History",
        role: "activity",
        component: HistoryTab,
      },
    ],
  });
};
