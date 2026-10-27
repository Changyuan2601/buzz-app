import { repositoriesContext } from "../../features/communities/repositories";
import { isTauri } from "@tauri-apps/api/core";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import type { AgentTypeConfig } from "../../features/agents/service";
import type { PluginModule } from "../../plugins/api";
import { CodexLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, defaults, validWorkspace } from "./config";
import { codexRun, TYPE_ID } from "./run";
import { activityHandle, CodexRuntime } from "./runtime";
import { CodexSetup, withScript } from "./setup";
import { CodexProvider, createTabs, transcripts } from "./tabs";
import { readUsage } from "./usage";
/** How often Buzz's copy of Codex looks for a new release. */
const UPDATE_MS = 6 * 60 * 60_000;
// Only the desktop app can start `codex`, and setup and file uploads run
// `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
const supported = () => isTauri() && /Mac|Linux/i.test(navigator.platform);

/** What the type's UI reaches of its runtime. */
type CodexExposed = Readonly<{
  provider: Parameters<typeof createTabs>[0];
  runtime: Parameters<typeof createTabs>[1];
  transcript: Parameters<typeof createTabs>[2];
  setup: Parameters<typeof createTabs>[3];
}>;

/** The type's pure config functions: the service needs them to create and
 * retype agents, and screens to show them. */
const typeConfig = {
  defaults: () => ({ config: { ...defaults } }),
  importShared: (source) =>
    source.runtime === "codex" &&
    (!source.provider || source.provider === "openai")
      ? { ...defaults, model: source.model }
      : undefined,
  adopt: (carry, saved) => ({
    ...saved,
    instructions: carry.instructions ?? saved.instructions,
    // Codex runs only in an absolute or home workspace.
    workspace:
      carry.workspace && validWorkspace(carry.workspace)
        ? carry.workspace
        : saved.workspace,
  }),
  carry: (saved) => {
    const { instructions, workspace } = config(saved);
    return {
      ...(instructions.trim() && { instructions }),
      ...(workspace !== defaults.workspace && { workspace }),
    };
  },
  describeMigration: (saved) => {
    const { model, effort, scope } = config(saved);
    return [
      { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
      {
        id: "thinking",
        label: "Thinking",
        isOverride: Boolean(effort),
      },
      {
        id: "sessions",
        label: "Sessions",
        isOverride: scope !== defaults.scope,
        unchangedKey: scope,
      },
    ];
  },
  migrationWarning: "Any commands Codex left running will stop.",
  summary: (agent) => config(agent.config).model || "Codex",
} satisfies AgentTypeConfig<Config>;

export const inject = ["agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!supported()) return;
  ctx.agents.present<CodexExposed, Config>(
    TYPE_ID,
    ({ provider, runtime, transcript, setup }) => {
      const {
        Create,
        CreateModel,
        DefaultControl,
        ProviderDialogBody,
        SettingsTab,
        ActivityTab,
      } = createTabs(provider, runtime, transcript, setup);
      return {
        ...typeConfig,
        icon: CodexLogoIcon,
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
    },
  );
};

// The runtime, which runs where the agents do.
export const agent: NonNullable<PluginModule["agent"]> = {
  inject: ["agents", "host"],
  apply: (ctx) => applyAgent(ctx),
};
function applyAgent(ctx: Parameters<PluginModule["apply"]>[0]) {
  if (!supported()) return;
  const spawn = ctx.host.spawn && withScript(ctx.host.spawn.bind(ctx.host));
  const readFile = ctx.host.readFile?.bind(ctx.host);
  const setup = new CodexSetup(spawn, (input) => ctx.host.request(input));
  const start =
    spawn ??
    (async () => {
      throw new Error("Codex agents run only in the desktop app");
    });
  const providerController = new CodexProvider(
    start,
    ctx.agents.storage,
    setup,
  );
  const runtime = new CodexRuntime(
    start,
    (key) => ownerReads(ctx.agents.relay(key), pubkeyOf(key)),
    (key, signal) => ctx.agents.core(key, signal),
    ctx.agents.storage,
    (raw) => providerController.resolve(raw),
    () => ctx.agents.tools(),
    repositoriesContext,
  );
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.codex"}/${TYPE_ID}`;
  /** A Codex agent is running, so Buzz's copy is needed; unknown until the
   * agents have loaded. */
  let needed: boolean | undefined;
  // Agents that stop running stop their turns, and the last one stops the
  // server; switching communities or a reconnect does not.
  const sync = () => {
    const snapshot = ctx.agents.snapshot();
    if (snapshot.status === "loading") return;
    const running = snapshot.running.filter((agent) => agent.type === typeKey);
    runtime.sync(running);
    // Once loaded, and when the first Codex agent runs, the copy is brought
    // up to date; that is also when a first copy is downloaded.
    const was = needed;
    needed = running.length > 0;
    if (spawn && (was === undefined || (needed && !was))) {
      const updated = setup.update(needed);
      // Then, after the check that follows it (two first starts of Codex
      // race on its state), a usable copy's server starts so the first
      // mention skips its startup. One being installed is left to the mention.
      if (needed)
        void updated
          .then(() => providerController.check())
          .then(
            () => {
              if (
                needed &&
                !setup.snapshot().running &&
                providerController.snapshot().readiness === "ready"
              )
                runtime.warm();
            },
            () => undefined,
          );
    }
  };
  const offAgents = ctx.agents.subscribe(sync);
  const offProvider = providerController.subscribe(sync);
  sync();
  const timer =
    spawn && setInterval(() => void setup.update(needed ?? false), UPDATE_MS);
  ctx.effect(() => () => {
    needed = false;
    clearInterval(timer);
    offAgents();
    offProvider();
    providerController.dispose();
    runtime.dispose();
    setup.dispose();
  });
  ctx.agents.register<Config>({
    id: TYPE_ID,
    title: "Codex",
    description:
      "Codex on this computer, using its native coding tools and your account.",
    ...typeConfig,
    expose: {
      provider: providerController,
      runtime: activityHandle(runtime),
      transcript: transcripts(start, runtime),
      setup,
    } satisfies CodexExposed,
    ...(spawn &&
      readFile && {
        usage: (agent, { since, signal }) =>
          readUsage({ spawn, readFile }, agent, since, signal),
      }),
    provider: {
      snapshot: providerController.snapshot,
      subscribe: providerController.subscribe,
      check: () => providerController.check(),
    },
    sessions: {
      list: (key) => {
        const views = new Map(
          runtime.sessions(key).map((view) => [view.key, view.status]),
        );
        return runtime
          .conversations(key)
          .map(({ key, channelId, root, at }) => {
            const status = views.get(key);
            return {
              channelId,
              ...(root && { root }),
              ...(at !== undefined && { at }),
              ...(status && { status }),
            };
          });
      },
      subscribe: runtime.subscribe,
    },
    // A mention during the first download waits for it, within its deadline.
    ...codexRun(runtime, async (signal) => {
      await setup.installed(signal);
      if (providerController.snapshot().readiness === "checking")
        await providerController.check();
    }),
  });
}
