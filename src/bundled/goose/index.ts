// goose agents: an agent type whose agents are goose on this computer, all in
// one `goose-acp` process. Each conversation an agent is in is one ACP session
// in it; goose answers with the in-process Buzz tools, served to it over
// loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, DEFAULT_CONFIG, GooseRuntime } from "./runtime";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";

export const TYPE_ID = "goose";
/** A turn's run returns once goose has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

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
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
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
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
  });
};
