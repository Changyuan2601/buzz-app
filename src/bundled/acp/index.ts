// ACP agents: an agent type for any harness that speaks the Agent Client
// Protocol, started from a preset or a command the owner types and confirms.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { adopt, carry, type Config, config, DEFAULT_CONFIG } from "./config";
import { check } from "./harness";
import { preset } from "./presets";
import { AcpRuntime } from "./runtime";
import { createTabs } from "./tabs";

export const TYPE_ID = "acp";
/** A turn's run returns once the harness has it, so this bounds only the
 * hand-over. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start a harness, and its launch runs POSIX
  // `env`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const spawn = host.spawn?.bind(host);
  if (!spawn) return;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.acp"}/${TYPE_ID}`;
  const runtime = new AcpRuntime(
    host,
    agents.relay,
    (pubkey, signal) => agents.core(pubkey, signal),
    () => agents.tools(),
  );
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const unsubscribe = agents.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    unsubscribe();
    runtime.dispose();
  });
  const { SettingsTab, HistoryTab } = createTabs({
    // Launches the way a run does, so it checks exactly what a run would start.
    check: (value) => check(spawn, value),
  });
  agents.register<Config>({
    id: TYPE_ID,
    title: "ACP agent",
    description:
      "Any harness that speaks the Agent Client Protocol, from a preset or a command you confirm.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    // No `syncedSettings` on purpose: command, args, env and workspace must
    // never come from the relay, only from this device.
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
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
  });
};
