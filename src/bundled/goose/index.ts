import { repositoriesContext } from "../../features/communities/repositories";
// goose agents: an agent type whose agents are goose on this computer, all in
// one `goose-acp` process. Each conversation an agent is in is one ACP session
// in it; goose answers with the in-process Buzz tools, served to it over
// loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import type { AgentTypeConfig } from "../../features/agents/service";
import type { PluginModule } from "../../plugins/api";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import {
  activityHandle,
  type Config,
  config,
  DEFAULT_CONFIG,
  GooseRuntime,
} from "./runtime";
import { gooseRun } from "./run";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";
import { readUsage } from "./usage";

export const TYPE_ID = "goose";

/** What the type's UI reaches of its runtime. */
type GooseExposed = Parameters<typeof createTabs>[0];

/** The type's pure config functions: the service needs them to create and
 * retype agents, and screens to show them. */
const typeConfig = {
  defaults: () => ({ config: DEFAULT_CONFIG }),
  importShared: (source) =>
    source.runtime === "goose" || source.runtime === "goose-ai"
      ? {
          ...DEFAULT_CONFIG,
          model: source.model,
          provider: source.provider ?? "",
        }
      : undefined,
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
} satisfies AgentTypeConfig<Config>;

export const inject = ["agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `goose-acp`; no unusable type elsewhere.
  if (!isTauri()) return;
  ctx.agents.present<GooseExposed, Config>(TYPE_ID, (exposed) => {
    const {
      Create,
      CreateModel,
      SettingsTab,
      ActivityTab,
      DefaultControl,
      ProviderDialogBody,
    } = createTabs(exposed);
    return {
      ...typeConfig,
      icon: GooseLogoIcon,
      Create,
      CreateModel,
      provider: { DialogBody: ProviderDialogBody, DefaultControl },
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
    };
  });
};

// The runtime, which runs where the agents do.
export const agent: NonNullable<PluginModule["agent"]> = {
  inject: ["agents", "host"],
  apply: (ctx) => applyAgent(ctx),
};
function applyAgent(ctx: Parameters<PluginModule["apply"]>[0]) {
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.goose"}/${TYPE_ID}`;
  const runtime = new GooseRuntime(
    host,
    agents.relay,
    (key, signal) => agents.core(key, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
  );
  const desktop =
    host.spawn && host.resolveDirectory
      ? {
          spawn: host.spawn.bind(host),
          resolveDirectory: host.resolveDirectory.bind(host),
        }
      : undefined;
  const setup = new GooseSetup(desktop, () => runtime.defaultsChanged());
  const history = new GooseHistory(desktop);
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
    description:
      "goose on this computer, with any provider goose supports. Each thread it is mentioned in is one continuing session.",
    ...typeConfig,
    expose: {
      setup,
      runtime: activityHandle(runtime),
      history,
    } satisfies GooseExposed,
    provider: {
      snapshot: setup.snapshot,
      subscribe: setup.subscribe,
      check: setup.check,
    },
    sessions: {
      list: (key) => {
        const live = runtime.sessions(key);
        const busy = new Map(live.map((view) => [view.key, view.busy]));
        const used = new Map(
          runtime.conversations(key).map(({ key, at }) => [key, at]),
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
    ...(desktop && {
      usage: (agent, { since, signal }) =>
        readUsage(
          history,
          agent.key,
          config(agent.config).workspace,
          since,
          signal,
        ),
    }),
    models: (agent) => setup.picks(config(agent.config)),
    ...gooseRun(runtime),
  });
}
