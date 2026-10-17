// goose agents: an agent type whose agents are goose on this computer, all in
// one `goose-acp` process. Each conversation an agent is in is one ACP session
// in it; goose answers with the in-process Buzz tools, served to it over
// loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, DEFAULT_CONFIG, GooseRuntime } from "./runtime";
import { gooseRun } from "./run";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";

export const TYPE_ID = "goose";

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `goose-acp`, and file uploads run `base64`,
  // which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.goose"}/${TYPE_ID}`;
  const runtime = new GooseRuntime(
    host,
    agents.relay,
    (pubkey, signal) => agents.core(pubkey, signal),
    localStorage,
    () => agents.tools(),
  );
  const spawn = host.spawn?.bind(host);
  const setup = new GooseSetup(spawn);
  const { Create, CreateModel, SettingsTab, ActivityTab } = createTabs({
    setup,
    runtime,
    history: new GooseHistory(spawn),
  });
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  if (host.spawn) {
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    title: "Goose",
    icon: GooseLogoIcon,
    description:
      "goose on this computer, with any provider goose supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    CreateModel,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => {
      const { model, provider } = config(agent.config);
      return [provider, model].filter(Boolean).join(" · ") || "Goose";
    },
    sessions: {
      list: (pubkey) => {
        const live = runtime.sessions(pubkey);
        const busy = new Map(live.map((view) => [view.key, view.busy]));
        const used = new Map(
          runtime.conversations(pubkey).map(({ key, at }) => [key, at]),
        );
        // Open ones are listed even when saving them failed. A one-off turn
        // joins no conversation.
        for (const { key, at } of live) if (at !== undefined) used.set(key, at);
        return [...used]
          .sort(([, a], [, b]) => b - a)
          .map(([key, at]) => {
            const [channelId = key, root] = key.split("/");
            const working = busy.get(key);
            return {
              channelId,
              ...(root && { root }),
              at,
              ...(working !== undefined && {
                status: working ? "Working" : "Idle",
              }),
            };
          });
      },
      subscribe: (listener) => runtime.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    models: (agent) => setup.picks(config(agent.config)),
    ...gooseRun(runtime),
  });
};
