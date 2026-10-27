import { repositoriesContext } from "../../features/communities/repositories";
// Claude agents: an agent type whose agents are Claude sessions on
// this computer. Each conversation the agent is in is one continuing session;
// Claude answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import type { AgentTypeConfig } from "../../features/agents/service";
import type { PluginModule } from "../../plugins/api";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { claudeRun, TYPE_ID } from "./run";
import { ClaudeDefaults } from "./defaults";
import { ClaudeRuntime, type Config, config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup, withScript } from "./setup";
import { createTabs } from "./tabs";
import { readUsage } from "./usage";

export { TYPE_ID };
/** How often Buzz's copy of Claude looks for a new release. */
const UPDATE_MS = 6 * 60 * 60_000;

// Only the desktop app can start `claude`, and setup and file uploads run
// `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
const supported = () => isTauri() && /Mac|Linux/i.test(navigator.platform);

/** What the type's UI reaches of its runtime. */
export type ClaudeExposed = Parameters<typeof createTabs>[0];

/** The type's pure config functions: the service needs them to create and
 * retype agents, and screens to show them. */
const typeConfig = {
  defaults: () => ({ config: DEFAULT_CONFIG }),
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
  describeMigration: (saved) => {
    const { model, effort, scope } = config(saved);
    return [
      { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
      { id: "thinking", label: "Thinking", isOverride: Boolean(effort) },
      {
        id: "sessions",
        label: "Sessions",
        isOverride: scope !== DEFAULT_CONFIG.scope,
        unchangedKey: scope,
      },
    ];
  },
  summary: (agent) => config(agent.config).model || "Claude",
} satisfies AgentTypeConfig<Config>;

export const inject = ["agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!supported()) return;
  ctx.agents.present<ClaudeExposed, Config>(TYPE_ID, (exposed) => {
    const {
      Create,
      CreateModel,
      DefaultControl,
      ProviderDialogBody,
      SettingsTab,
      ActivityTab,
    } = createTabs(exposed);
    return {
      ...typeConfig,
      icon: ClaudeLogoIcon,
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
  if (!supported()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.claude-code"}/${TYPE_ID}`;
  const spawn = host.spawn && withScript(host.spawn.bind(host));
  const readFile = host.readFile?.bind(host);
  const setup = new ClaudeSetup(spawn, (input) => host.request(input));
  const providerDefaults = new ClaudeDefaults(agents.storage);
  const runtime = new ClaudeRuntime(
    spawn ? { spawn } : {},
    (key) => ownerReads(agents.relay(key), pubkeyOf(key)),
    (key, signal) => agents.core(key, signal),
    agents.storage,
    (raw) => providerDefaults.resolve(raw),
    () => agents.tools(),
    repositoriesContext,
  );
  /** A Claude agent is running, so Buzz's copy is needed; unknown until the
   * agents have loaded. */
  let needed: boolean | undefined;
  const sync = () => {
    const snapshot = agents.snapshot();
    // Agents that stop running, the app signing out included, stop their
    // processes; switching communities does not.
    if (snapshot.status === "loading") return;
    const running = snapshot.running.filter((agent) => agent.type === typeKey);
    runtime.sync(running);
    // Once loaded, and when the first Claude agent runs, the copy is brought
    // up to date; that is also when a first copy is downloaded.
    const was = needed;
    needed = running.length > 0;
    if (was === undefined || (needed && !was)) void setup.update(needed);
  };
  // One spare session waits for whichever running agent needs it next.
  if (spawn) {
    const unsubscribe = agents.subscribe(sync);
    const unsubscribeDefaults = providerDefaults.subscribe(sync);
    sync();
    const timer = setInterval(
      () => void setup.update(needed ?? false),
      UPDATE_MS,
    );
    ctx.effect(() => () => {
      clearInterval(timer);
      unsubscribe();
      unsubscribeDefaults();
      runtime.dispose();
      setup.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    title: "Claude",
    description:
      "Claude on this computer. Each thread it is mentioned in is one continuing session.",
    ...typeConfig,
    expose: {
      setup,
      defaults: providerDefaults,
      runtime,
    } satisfies ClaudeExposed,
    ...(spawn &&
      readFile && {
        usage: (agent, { since, signal }) =>
          readUsage(
            { spawn, readFile },
            config(agent.config).workspace,
            agent.key,
            runtime.conversations(agent.key).map((saved) => saved.sessionId),
            since,
            signal,
          ),
      }),
    provider: {
      snapshot: setup.providerSnapshot,
      subscribe: setup.subscribe,
      check: () => setup.check(),
      get attentionAction() {
        const state = setup.snapshot();
        if (state.running) return undefined;
        return state.status?.state === "missing" ||
          state.status?.state === "outdated"
          ? () => void setup.run("install")
          : state.status?.state === "signed-out"
            ? () => void setup.run("login")
            : undefined;
      },
    },
    sessions: {
      list: (key) => {
        const busy = new Map(
          runtime.sessions(key).map((view) => [view.key, view.busy]),
        );
        return runtime
          .conversations(key)
          .map(({ key, channelId, root, at }) => {
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
    // A mention during the first download waits for it, within its deadline.
    ...claudeRun(runtime, (signal) => setup.installed(signal)),
  });
}
