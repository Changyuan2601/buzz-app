// goose's providers, as its own config holds them: the ones it offers, their
// models, saving a provider's key, and testing that a provider answers. Each
// call runs a short-lived `goose-acp`; keys go to goose's secret store, never
// into Buzz.
import type { ModelChoice } from "../../features/agents/ModelPicker";
import type {
  AgentProviderSnapshot,
  Models,
} from "../../features/agents/service";
import { GooseProcess, type Choice, type Spawn } from "./goose";
import { absolute } from "./sessions";

export type ConfigKey = Readonly<{
  name: string;
  required: boolean;
  secret: boolean;
  default?: string | null;
}>;

export type Provider = Readonly<{
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  configured: boolean;
  /** The fields a key or host is entered in. */
  keys: readonly ConfigKey[];
  /** Signs in through goose rather than with a key entered here. */
  signsIn: boolean;
  steps: readonly string[];
  models: readonly ModelChoice[];
}>;

export type Providers = Readonly<{
  providers: readonly Provider[];
  /** What goose's config picks when an agent names no provider or model. */
  defaults: Readonly<{ provider?: string; model?: string }>;
}>;

export type Tested = Readonly<{ ok: boolean; message: string }>;

/** The thinking levels goose offers for a provider and model. */
export type Efforts = Readonly<{
  /** The level goose runs it on when none is chosen. */
  current: string;
  levels: readonly string[];
}>;

/** A session's settings, as `session/new` and `session/set_config_option`
 * return them. */
type ConfigOptions = {
  configOptions?: {
    category?: string | null;
    currentValue?: string;
    options?: { value: string }[];
  }[];
};

type Entry = {
  providerId: string;
  providerName: string;
  description?: string;
  defaultModel?: string;
  configured?: boolean;
  visibleInSetup?: boolean;
  deprecated?: boolean;
  acp?: boolean;
  setupSteps?: string[];
  configKeys?: (ConfigKey & {
    oauthFlow?: boolean;
    deviceCodeFlow?: boolean;
  })[];
  models?: { id: string; recommended?: boolean }[];
};

/** A special case for the goose plugin's Databricks provider: goose's catalog
 * keeps one endpoint per model name, which can be another team's
 * (`auto-labeler-…-gpt-6-luna` for GPT-6 Luna). Offer the provider's own list,
 * only the workspace's endpoints and goose's own. */
const PREFIXES: Readonly<Record<string, readonly string[]>> = {
  databricks: ["databricks-", "goose-"],
};

const TEST_PROMPT = "Reply with exactly: OK";

export class GooseSetup {
  private listing: Promise<Providers> | undefined;
  private readonly live = new Map<string, Promise<readonly ModelChoice[]>>();
  private readonly thinking = new Map<string, Promise<Efforts>>();

  private state: AgentProviderSnapshot = { readiness: "checking" };
  private readonly listeners = new Set<() => void>();
  private checkedDefaults: string | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    private readonly spawn: Spawn | undefined,
    private readonly defaultsChanged: () => void = () => {},
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: AgentProviderSnapshot) {
    this.state = {
      ...state,
      blocking: state.blocking ?? this.state.blocking ?? false,
    };
    for (const listener of this.listeners) listener();
  }

  /** A fresh read also notices changes made by `goose configure`. */
  check = (): Promise<void> => {
    if (this.checking) return this.checking;
    this.listing = undefined;
    this.live.clear();
    this.thinking.clear();
    this.update({ readiness: "checking" });
    this.checking = this.providers()
      .then(
        ({ defaults, providers }) => {
          const key = JSON.stringify(defaults);
          if (
            this.checkedDefaults !== undefined &&
            this.checkedDefaults !== key
          )
            this.defaultsChanged();
          this.checkedDefaults = key;
          const ready = providers.some(
            (provider) =>
              provider.id === defaults.provider &&
              provider.configured &&
              Boolean(defaults.model?.trim()),
          );
          this.update(
            ready
              ? { readiness: "ready" }
              : { readiness: "attention", attentionLabel: "Set up Goose" },
          );
        },
        () =>
          this.update({
            readiness: "attention",
            attentionLabel: "Check Goose setup",
          }),
      )
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  };

  /** Writes Goose's own defaults, never a parallel Buzz preference. */
  async saveDefaults(
    choice: Choice,
    fields: Readonly<Record<string, string>> = {},
  ) {
    await this.checking;
    this.update({ ...this.state, blocking: true });
    try {
      if (Object.keys(fields).length) await this.save(choice.provider, fields);
      const providerId = choice.provider.trim();
      const { defaults, providers } = await this.providers();
      await this.with(async (goose) => {
        let modelId =
          choice.model.trim() ||
          (providerId === defaults.provider ? defaults.model?.trim() : "");
        if (!modelId) {
          // Goose stores per-provider choices separately from catalog metadata.
          const { value } = (await goose.request(
            "_goose/unstable/config/read",
            {
              key: "providers",
              isSecret: false,
            },
          )) as { value?: Record<string, { model?: unknown }> | null };
          const stored = value?.[providerId]?.model;
          modelId =
            (typeof stored === "string" ? stored.trim() : "") ||
            providers
              .find((provider) => provider.id === providerId)
              ?.defaultModel.trim();
        }
        if (!modelId)
          throw new Error(
            "Choose a default model with goose configure, then try again.",
          );
        await goose.request("_goose/unstable/defaults/save", {
          providerId,
          modelId,
        });
      });
      this.defaultsChanged();
      this.checkedDefaults = undefined;
      await this.check();
    } finally {
      this.update({ ...this.state, blocking: false });
    }
  }

  /** The models an agent on `choice` can be asked to run a turn on: those of
   * its provider, or goose's config's, and the one it runs on without. */
  async picks(choice: Choice): Promise<Models> {
    const provider = choice.provider.trim();
    const { providers, defaults } = await this.providers();
    const id = provider || defaults.provider;
    const current =
      choice.model.trim() ||
      (provider
        ? providers.find((item) => item.id === id)?.defaultModel
        : defaults.model) ||
      "";
    const models = (id ? await this.models(id) : []).map(({ id, label }) => ({
      id,
      label,
      efforts: [],
    }));
    // A model its provider does not list is still the one it runs on.
    return !current || models.some((model) => model.id === current)
      ? { current, models }
      : {
          current,
          models: [{ id: current, label: current, efforts: [] }, ...models],
        };
  }

  /** goose's providers, read once until something is saved. */
  providers(): Promise<Providers> {
    this.listing ??= this.with(async (goose) => {
      const [{ entries }, defaults] = (await Promise.all([
        goose.request("_goose/unstable/providers/list", { providerIds: [] }),
        goose.request("_goose/unstable/defaults/read", {}),
      ])) as [
        { entries: Entry[] },
        { providerId?: string | null; modelId?: string | null },
      ];
      return {
        // Providers that are other agents (`claude-acp`, …) are not offered.
        providers: entries
          .filter(
            (entry) => entry.visibleInSetup && !entry.deprecated && !entry.acp,
          )
          .map(provider)
          .sort((a, b) => a.name.localeCompare(b.name)),
        defaults: {
          ...(defaults.providerId ? { provider: defaults.providerId } : {}),
          ...(defaults.modelId ? { model: defaults.modelId } : {}),
        },
      };
    });
    this.listing.catch(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  /** Databricks catalogs can lag its endpoints and AI Gateway services;
   * configured providers use live discovery for both Databricks versions. */
  async models(id: string): Promise<readonly ModelChoice[]> {
    const listed = (await this.providers()).providers.find(
      (item) => item.id === id,
    );
    const prefixes = PREFIXES[id];
    const models =
      listed?.configured &&
      (prefixes || id === "databricks_v2" || !listed.models.length)
        ? await this.supported(id)
        : (listed?.models ?? []);
    return prefixes
      ? models.filter((model) =>
          prefixes.some((prefix) => model.id.startsWith(prefix)),
        )
      : models;
  }

  private supported(id: string): Promise<readonly ModelChoice[]> {
    let models = this.live.get(id);
    if (!models) {
      models = this.with(async (goose) => {
        const { models } = (await goose.request(
          "_goose/unstable/providers/supported-models/list",
          { providerId: id },
        )) as { models: string[] };
        return models.map((model) => ({ id: model, label: model }));
      });
      models.catch(() => this.live.delete(id));
      this.live.set(id, models);
    }
    return models;
  }

  /** The thinking levels goose offers on `choice`'s provider and model, as a
   * session opened on them lists. goose without them offers none.
   *
   * ACP lists config options only per session, and only for the model the
   * session is on, so this opens a throwaway session and moves it to the
   * model to read them. */
  efforts(choice: Choice): Promise<Efforts> {
    const provider = choice.provider.trim();
    const model = choice.model.trim();
    const key = `${provider}\u0000${model}`;
    let efforts = this.thinking.get(key);
    if (!efforts) {
      efforts = this.with(async (goose, cwd) => {
        const opened = (await goose.request("session/new", {
          cwd,
          mcpServers: [],
          _meta: { enabledExtensions: [], ...(provider ? { provider } : {}) },
        })) as ConfigOptions & { sessionId: string };
        try {
          const { configOptions = [] } = model
            ? ((await goose.request("session/set_config_option", {
                sessionId: opened.sessionId,
                configId: "model",
                value: model,
              })) as ConfigOptions)
            : opened;
          const option = configOptions.find(
            (item) => item.category === "thought_level",
          );
          return {
            current: option?.currentValue ?? "",
            levels: (option?.options ?? []).map(({ value }) => value),
          };
        } finally {
          // goose keeps every session; this one is not worth keeping.
          await goose
            .request("session/delete", { sessionId: opened.sessionId })
            .catch(() => undefined);
        }
      });
      efforts.catch(() => this.thinking.delete(key));
      this.thinking.set(key, efforts);
    }
    return efforts;
  }

  /** Which of a provider's fields goose already holds. */
  saved(id: string): Promise<ReadonlySet<string>> {
    return this.with(async (goose) => {
      const { fields } = (await goose.request(
        "_goose/unstable/providers/config/read",
        { providerId: id },
      )) as { fields: { key: string; isSet: boolean }[] };
      return new Set(
        fields.filter((field) => field.isSet).map((field) => field.key),
      );
    });
  }

  /** Saves a provider's fields in goose's config and secret store. */
  async save(id: string, fields: Readonly<Record<string, string>>) {
    await this.with((goose) =>
      goose.request("_goose/unstable/providers/config/save", {
        providerId: id,
        fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
      }),
    );
    this.listing = undefined;
    this.live.delete(id);
    this.thinking.clear();
  }

  /** Asks the provider for one short reply, without tools. goose reports a
   * failed call as its reply, so only the expected answer passes. */
  test(choice: Choice, signal?: AbortSignal): Promise<Tested> {
    const env = { GOOSE_MODE: "chat" };
    return this.with(
      async (goose, cwd) => {
        const session = await goose.open({
          cwd,
          systemPrompt: "",
          choice: () => choice,
        });
        try {
          const settled = await session.send(TEST_PROMPT);
          const reply = settled.text?.trim() ?? "";
          if (settled.ok && /^\W*ok\W*$/i.test(reply))
            return { ok: true, message: "Connected" };
          return {
            ok: false,
            message: reply || settled.error || "The provider sent no reply",
          };
        } finally {
          await goose.close(session);
          // goose keeps every session; this one is not worth keeping.
          await goose
            .request("session/delete", { sessionId: session.id })
            .catch(() => undefined);
        }
      },
      env,
      signal,
    ).catch((error: unknown) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }));
  }

  private with<T>(
    run: (goose: GooseProcess, cwd: string) => Promise<T>,
    env: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return briefly(this.spawn, run, env, signal);
  }
}

/** Runs `run` against a `goose-acp` started for it in the home folder, and
 * stops it after. It serves no Buzz tools. */
export async function briefly<T>(
  spawn: Spawn | undefined,
  run: (goose: GooseProcess, cwd: string) => Promise<T>,
  env: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<T> {
  if (!spawn) throw new Error("goose runs only in the desktop app");
  const active = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(60_000),
  ]);
  const start: Spawn = async (id, options) => {
    active.throwIfAborted();
    const child = await spawn(id, options);
    const kill = () => void child.kill();
    active.addEventListener("abort", kill, { once: true });
    void child.exited.finally(() => active.removeEventListener("abort", kill));
    if (active.aborted) {
      await child.kill();
      active.throwIfAborted();
    }
    return child;
  };
  const cwd = await absolute(start, "~");
  const goose = await GooseProcess.start(start, {
    cwd,
    env,
  });
  try {
    active.throwIfAborted();
    const result = await run(goose, cwd);
    active.throwIfAborted();
    return result;
  } finally {
    await goose.kill();
  }
}

function provider(entry: Entry): Provider {
  const keys = entry.configKeys ?? [];
  const models = [...(entry.models ?? [])].sort(
    (a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
  );
  return {
    id: entry.providerId,
    name: entry.providerName,
    description: entry.description ?? "",
    defaultModel: entry.defaultModel ?? "",
    configured: Boolean(entry.configured),
    keys: keys
      .filter((key) => !key.oauthFlow && !key.deviceCodeFlow)
      .map(({ name, required, secret, default: fallback }) => ({
        name,
        required,
        secret,
        default: fallback ?? null,
      })),
    signsIn: keys.some((key) => key.oauthFlow || key.deviceCodeFlow),
    steps: entry.setupSteps ?? [],
    // The exact ID: a catalog name can stand for several models.
    models: models.map((model) => ({ id: model.id, label: model.id })),
  };
}

/** `ANTHROPIC_API_KEY` reads as `API key`, `OPENAI_HOST` as `Host`. */
export function keyLabel(name: string) {
  const words = name.split("_").slice(1);
  const text = (words.length ? words : [name]).join(" ").toLowerCase();
  return (text.charAt(0).toUpperCase() + text.slice(1))
    .replace(/\bapi\b/i, "API")
    .replace(/\burl\b/i, "URL");
}
