// Claude Code agents: an Agents2 type whose agents are Claude Code sessions on
// this computer. Each conversation the agent is in is one continuing session;
// Claude answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { ClaudeRuntime, type Config, config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup } from "./setup";
import { createTabs } from "./tabs";

export const TYPE_ID = "claude-code";
/** A turn's run returns once Claude has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents2", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `claude`, and setup and file uploads run
  // `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents2, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.claude-code"}/${TYPE_ID}`;
  const spawn = host.spawn?.bind(host);
  const setup = new ClaudeSetup(spawn);
  const runtime = new ClaudeRuntime(host, agents2.relay);
  const sync = () => {
    const snapshot = agents2.snapshot();
    // Agents that stop running, the app signing out included, stop their
    // processes; switching communities does not.
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  // One spare session waits for whichever running agent needs it next.
  if (spawn) {
    const unsubscribe = agents2.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
      setup.dispose();
    });
  }

  const { ClaudeTab, SettingsTab } = createTabs({ setup, runtime });
  agents2.register<Config>({
    id: TYPE_ID,
    title: "Claude Code",
    description:
      "Claude Code on this computer. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    summary: (agent) => config(agent.config).model || "Claude Code",
    tabs: [
      { id: "claude", title: "Claude", component: ClaudeTab },
      { id: "settings", title: "Settings", component: SettingsTab },
    ],
    run: (delivery) => runtime.run(delivery),
    timeoutMs: HANDOVER_MS,
  });
};
