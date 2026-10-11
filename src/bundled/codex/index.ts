import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { defaults, config } from "./config";
import { CodexRuntime } from "./runtime";
import { createTabs } from "./tabs";
export const inject = ["react", "agents2", "host", "relay", "communityReader"];
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
  const runtime = new CodexRuntime(start, ctx.relay);
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.codex"}/codex`;
  let selection = "";
  const sync = () => {
    const community = ctx.communityReader.snapshot();
    const selected = JSON.stringify([community.selected, community.viewer]);
    if (selected !== selection) {
      runtime.dispose();
      selection = selected;
    }
    const snapshot = ctx.agents2.snapshot();
    const relay = ctx.relay.snapshot();
    if (relay.status === "disconnected") {
      runtime.sync([], "");
      return;
    }
    if (snapshot.status !== "ready" || relay.status !== "ready") return;
    runtime.sync(
      snapshot.agents.filter((agent) => agent.type === typeKey),
      relay.scope ?? "",
    );
  };
  const offAgents = ctx.agents2.subscribe(sync);
  const offRelay = ctx.relay.subscribe(sync);
  const offCommunity = ctx.communityReader.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    offAgents();
    offRelay();
    offCommunity();
    runtime.dispose();
  });
  const { CodexTab, SettingsTab } = createTabs(ctx.react, start, runtime);
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
    models: (agent) => runtime.preview(agent),
    run: (delivery) => runtime.run(delivery),
    timeoutMs: 2 * 60_000,
  });
};
