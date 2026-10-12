import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { defaults, config } from "./config";
import { CodexRuntime } from "./runtime";
import { CodexSetup } from "./setup";
import { createTabs } from "./tabs";
export const inject = ["react", "agents2", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `codex`, and file uploads run `base64`,
  // which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const spawn = ctx.host.spawn?.bind(ctx.host);
  const start =
    spawn ??
    (async () => {
      throw new Error("Codex agents run only in the desktop app");
    });
  const runtime = new CodexRuntime(start, ctx.agents2.relay);
  // Agents' shared server reads credentials only at startup, so it is renewed
  // after sign-in even if the tab that started it has closed.
  const setup = new CodexSetup(start, () => void runtime.reauthorize());
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.codex"}/codex`;
  // Agents that stop running stop their turns, and the last one stops the
  // server; switching communities or a reconnect does not.
  const sync = () => {
    const snapshot = ctx.agents2.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const offAgents = ctx.agents2.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    offAgents();
    runtime.dispose();
    void setup.cancel();
  });
  const { CodexTab, SettingsTab } = createTabs(
    ctx.react,
    start,
    runtime,
    setup,
  );
  ctx.agents2.register({
    id: "codex",
    title: "Codex",
    description:
      "Codex on this computer, using its native coding tools and your account.",
    defaults: () => ({ config: { ...defaults } }),
    summary: (agent) => config(agent.config).model || "Codex",
    tabs: [
      { id: "codex", title: "Codex", component: CodexTab },
      { id: "settings", title: "Settings", component: SettingsTab },
    ],
    run: (delivery) => runtime.run(delivery),
    timeoutMs: 2 * 60_000,
  });
};
