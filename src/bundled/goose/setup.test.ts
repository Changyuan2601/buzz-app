import { describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, type Spawn } from "./goose";
import { fakeSpawn } from "./goose-testing";
import { GooseSetup, keyLabel } from "./setup";

const ANTHROPIC = {
  providerId: "anthropic",
  providerName: "Anthropic",
  description: "Claude models",
  defaultModel: "claude-sonnet-5-5",
  configured: false,
  visibleInSetup: true,
  configKeys: [
    { name: "ANTHROPIC_API_KEY", required: true, secret: true },
    {
      name: "ANTHROPIC_HOST",
      required: false,
      secret: false,
      default: "https://api.anthropic.com",
    },
  ],
  setupSteps: ["Create a key at console.anthropic.com"],
  models: [
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", recommended: true },
  ],
};

const PROVIDERS = [
  ANTHROPIC,
  {
    providerId: "ollama",
    providerName: "Ollama",
    defaultModel: "qwen3",
    configured: true,
    visibleInSetup: true,
    configKeys: [{ name: "OLLAMA_HOST", required: true, secret: false }],
  },
  {
    providerId: "databricks",
    providerName: "Databricks",
    configured: false,
    visibleInSetup: true,
    configKeys: [
      { name: "DATABRICKS_HOST", required: true, secret: false },
      {
        name: "DATABRICKS_TOKEN",
        required: false,
        secret: true,
        oauthFlow: true,
      },
    ],
  },
  { providerId: "hidden", providerName: "Hidden", visibleInSetup: false },
  {
    providerId: "old",
    providerName: "Old",
    visibleInSetup: true,
    deprecated: true,
  },
  {
    providerId: "claude-acp",
    providerName: "Claude Code",
    visibleInSetup: true,
    acp: true,
  },
];

const setup = (options: Parameters<typeof fakeSpawn>[0] = {}) => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "ollama", modelId: "qwen3" },
    ...options,
  });
  return { fake, setup: new GooseSetup(fake) };
};

describe("GooseSetup", () => {
  it("lists the providers set up here, by name, with goose's defaults", async () => {
    const { fake, setup: goose } = setup();
    const listed = await goose.providers();
    expect(listed.providers.map((item) => item.id)).toEqual([
      "anthropic",
      "databricks",
      "ollama",
    ]);
    expect(listed.defaults).toEqual({ provider: "ollama", model: "qwen3" });
    expect(listed.providers[0]).toMatchObject({
      name: "Anthropic",
      defaultModel: "claude-sonnet-5-5",
      signsIn: false,
      steps: ["Create a key at console.anthropic.com"],
      models: [
        { id: "claude-opus-5-5", label: "claude-opus-5-5" },
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5" },
      ],
    });
    expect(fake.geese.every((goose) => goose.killed)).toBe(true);
    await goose.providers();
    expect(fake.geese).toHaveLength(1);
  });

  it("leaves a provider that signs in to goose", async () => {
    const { setup: goose } = setup();
    const databricks = (await goose.providers()).providers.find(
      (item) => item.id === "databricks",
    );
    expect(databricks?.signsIn).toBe(true);
    expect(databricks?.keys.map((key) => key.name)).toEqual([
      "DATABRICKS_HOST",
    ]);
  });

  it("lists a set-up provider's models from its API when goose has none", async () => {
    const { setup: goose } = setup({ supported: ["qwen3", "llama4"] });
    expect(await goose.models("ollama")).toEqual([
      { id: "qwen3", label: "qwen3" },
      { id: "llama4", label: "llama4" },
    ]);
    expect((await goose.models("anthropic")).map((item) => item.id)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]);
    expect(await goose.models("databricks")).toEqual([]);
  });

  it("lists only the workspace's and goose's own Databricks endpoints", async () => {
    const { setup: goose } = setup({
      providers: PROVIDERS.map((entry) =>
        entry.providerId === "databricks"
          ? {
              ...entry,
              configured: true,
              models: [{ id: "auto-labeler-builderbot-gpt-6-luna" }],
            }
          : entry,
      ),
      supported: [
        "auto-labeler-builderbot-gpt-6-luna",
        "databricks-gpt-6-1-sol",
        "kgoose-gpt-6-luna",
        "databricks-gpt-6-luna",
        "goose-gpt-5-5",
      ],
    });
    expect(await goose.models("databricks")).toEqual([
      { id: "databricks-gpt-6-1-sol", label: "databricks-gpt-6-1-sol" },
      { id: "databricks-gpt-6-luna", label: "databricks-gpt-6-luna" },
      { id: "goose-gpt-5-5", label: "goose-gpt-5-5" },
    ]);
  });

  it("discovers Databricks V2 models despite a populated catalog and refreshes on check", async () => {
    const supported = ["goose-gpt-6-1-sol", "workspace.models.gpt-6-astra"];
    const { fake, setup: goose } = setup({
      providers: [
        {
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          configured: true,
          visibleInSetup: true,
          models: [{ id: "goose-gpt-5-5" }],
        },
      ],
      defaults: { providerId: "databricks_v2", modelId: "goose-gpt-5-5" },
      supported,
    });
    expect((await goose.models("databricks_v2")).map(({ id }) => id)).toEqual(
      supported,
    );
    await goose.models("databricks_v2");
    const requests = () =>
      fake.geese
        .flatMap((process) => process.received)
        .filter(
          (message) =>
            message.method ===
            "_goose/unstable/providers/supported-models/list",
        );
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.params).toEqual({ providerId: "databricks_v2" });
    supported.push("goose-gpt-6-luna");
    await goose.check();
    expect((await goose.models("databricks_v2")).map(({ id }) => id)).toEqual(
      supported,
    );
    expect(requests()).toHaveLength(2);
  });

  it("offers an agent its provider's models, or those of goose's config", async () => {
    const { setup: goose } = setup({ supported: ["qwen3", "llama4"] });
    await expect(
      goose.picks({ provider: "anthropic", model: "" }),
    ).resolves.toEqual({
      current: "claude-sonnet-5-5",
      models: [
        { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5", efforts: [] },
        { id: "claude-opus-5-5", label: "claude-opus-5-5", efforts: [] },
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5", efforts: [] },
      ],
    });
    await expect(
      goose.picks({ provider: "anthropic", model: "claude-haiku-5-5" }),
    ).resolves.toMatchObject({
      current: "claude-haiku-5-5",
      models: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }],
    });
    await expect(goose.picks({ provider: "", model: "" })).resolves.toEqual({
      current: "qwen3",
      models: [
        { id: "qwen3", label: "qwen3", efforts: [] },
        { id: "llama4", label: "llama4", efforts: [] },
      ],
    });
  });

  it("loads each model's supported thinking levels for per-message picks", async () => {
    const { fake, setup: goose } = setup({
      thinking: {
        "claude-sonnet-5-5": {
          current: "medium",
          levels: ["low", "medium", "high"],
        },
        "claude-opus-5-5": { current: "max", levels: ["high", "max"] },
      },
    });
    const { models } = await goose.picks({ provider: "anthropic", model: "" });
    expect(models.map(({ efforts }) => efforts)).toEqual([
      [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      [
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
      [],
    ]);
    expect(
      (await goose.picks({ provider: "anthropic", model: "" })).models,
    ).toMatchObject([
      {
        id: "claude-sonnet-5-5",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "claude-opus-5-5",
        efforts: [
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
      },
      { id: "claude-haiku-5-5", efforts: [] },
    ]);
    const processCount = fake.geese.length;
    await goose.picks({ provider: "anthropic", model: "" });
    expect(fake.geese).toHaveLength(processCount);
  });

  it("keeps healthy model efforts when one probe times out", async () => {
    vi.useFakeTimers();
    try {
      const { fake, setup: goose } = setup({
        silentModels: ["claude-opus-5-5"],
        thinking: {
          "claude-sonnet-5-5": { current: "medium", levels: ["low", "high"] },
          "claude-haiku-5-5": { current: "off", levels: ["off"] },
        },
      });
      let settled = false;
      const pending = goose
        .picks({ provider: "anthropic", model: "" })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fake.geese.some((process) =>
          process.received.some(
            (request) =>
              request.method === "session/set_config_option" &&
              request.params?.value === "claude-opus-5-5",
          ),
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { models } = await pending;
      expect(models).toMatchObject([
        {
          id: "claude-sonnet-5-5",
          efforts: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        { id: "claude-opus-5-5", efforts: [] },
        { id: "claude-haiku-5-5", efforts: [{ id: "off", label: "Off" }] },
      ]);
      expect(fake.geese.every((process) => process.killed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes only the selected model when validating a run", async () => {
    const { setup: goose } = setup();
    let releaseUnrelated!: (value: {
      current: string;
      levels: string[];
    }) => void;
    const unrelated = new Promise<{ current: string; levels: string[] }>(
      (resolve) => {
        releaseUnrelated = resolve;
      },
    );
    const probe = vi
      .spyOn(goose, "efforts")
      .mockImplementation(({ model }) =>
        model === "claude-opus-5-5"
          ? Promise.resolve({ current: "max", levels: ["high", "max"] })
          : unrelated,
      );
    let settled = false;
    const pending = goose
      .picks({ provider: "anthropic", model: "" }, "claude-opus-5-5")
      .then((result) => {
        settled = true;
        return result;
      });

    try {
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      releaseUnrelated({ current: "", levels: [] });
    }
    await expect(pending).resolves.toMatchObject({
      models: [
        { id: "claude-sonnet-5-5", efforts: [] },
        { id: "claude-opus-5-5", efforts: [{ id: "high" }, { id: "max" }] },
        { id: "claude-haiku-5-5", efforts: [] },
      ],
    });
    expect(probe).toHaveBeenCalledExactlyOnceWith({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
  });

  it("probes the current model when the requested model is unavailable", async () => {
    const { setup: goose } = setup({
      thinking: {
        "claude-sonnet-5-5": { current: "low", levels: ["low", "high"] },
      },
    });
    const probe = vi.spyOn(goose, "efforts");

    const result = await goose.picks(
      { provider: "anthropic", model: "" },
      "unavailable-model",
    );

    expect(probe).toHaveBeenCalledExactlyOnceWith({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(result.models[0]?.efforts.map(({ id }) => id)).toEqual([
      "low",
      "high",
    ]);
  });

  it("preserves selected-model effort probe failures for run validation", async () => {
    const { setup: goose } = setup();
    vi.spyOn(goose, "efforts").mockRejectedValue(new Error("probe timed out"));

    await expect(
      goose.picks({ provider: "anthropic", model: "" }, "claude-opus-5-5"),
    ).rejects.toThrow("probe timed out");
  });

  it("skips effort probes for model-only run validation", async () => {
    const { setup: goose } = setup();
    const probe = vi
      .spyOn(goose, "efforts")
      .mockRejectedValue(new Error("probe timed out"));

    const result = await goose.picks(
      { provider: "anthropic", model: "" },
      "claude-opus-5-5",
      false,
    );

    expect(probe).not.toHaveBeenCalled();
    expect(result.models.map(({ id }) => id)).toContain("claude-opus-5-5");
  });

  it("limits simultaneous effort probes to four", async () => {
    const listed = Array.from({ length: 6 }, (_, index) => ({
      id: `model-${index}`,
    }));
    const { setup: goose } = setup({
      providers: PROVIDERS.map((entry) =>
        entry.providerId === "anthropic"
          ? { ...ANTHROPIC, models: listed }
          : entry,
      ),
    });
    let active = 0;
    let maximum = 0;
    const release: (() => void)[] = [];
    const probe = vi.spyOn(goose, "efforts").mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) =>
        release.push(() => {
          active -= 1;
          resolve();
        }),
      );
      return { current: "low", levels: ["low"] };
    });
    const pending = goose.picks({ provider: "anthropic", model: "" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(4));
    expect(active).toBe(4);
    for (const done of release.splice(0)) done();
    await vi.waitFor(() =>
      expect(probe).toHaveBeenCalledTimes(listed.length + 1),
    );
    expect(active).toBe(3);
    for (const done of release.splice(0)) done();
    await pending;
    expect(maximum).toBe(4);
  });

  it("saves a provider's fields into goose and reads the list again", async () => {
    const saved = new Map<string, Set<string>>();
    const { fake, setup: goose } = setup({ saved });
    await goose.providers();
    expect(await goose.saved("anthropic")).toEqual(new Set());
    await goose.save("anthropic", { ANTHROPIC_API_KEY: "sk-test" });
    const request = fake.geese
      .flatMap((goose) => goose.received)
      .find((message) => message.method?.endsWith("config/save"));
    expect(request?.params).toEqual({
      providerId: "anthropic",
      fields: [{ key: "ANTHROPIC_API_KEY", value: "sk-test" }],
    });
    expect(await goose.saved("anthropic")).toEqual(
      new Set(["ANTHROPIC_API_KEY"]),
    );
    const before = fake.geese.length;
    await goose.providers();
    expect(fake.geese).toHaveLength(before + 1);
  });

  it("passes a test the provider answers OK, in chat mode with no tools", async () => {
    const { fake, setup: goose } = setup({ reply: "OK." });
    expect(
      await goose.test({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toEqual({ ok: true, message: "Connected" });
    const [tested] = fake.geese;
    expect(tested?.env).toMatchObject({ GOOSE_MODE: "chat" });
    expect(tested?.env).toMatchObject({
      GOOSE_PROVIDER: null,
      GOOSE_MODEL: null,
    });
    expect(tested?.opened[0]).toMatchObject({
      mcpServers: [],
      _meta: { enabledExtensions: [], provider: "anthropic" },
    });
    expect(tested?.configured).toEqual(["session-1 model=claude-opus-5-5"]);
    expect(tested?.turns.map((turn) => turn.text)).toEqual([
      "Reply with exactly: OK",
    ]);
    expect(tested?.closed).toHaveLength(1);
    // goose would otherwise keep the test as a "New Chat" session.
    expect(tested?.deleted).toEqual(tested?.closed);
    expect(tested?.killed).toBe(true);
  });

  it("fails a test with what goose replied instead", async () => {
    const { fake, setup: goose } = setup({
      reply: "Authentication failed: invalid x-api-key",
    });
    expect(await goose.test({ provider: "anthropic", model: "" })).toEqual({
      ok: false,
      message: "Authentication failed: invalid x-api-key",
    });
    // The provider's default model, whatever goose's config names.
    const [tested] = fake.geese;
    expect(tested?.opened[0]?._meta).toMatchObject({ provider: "anthropic" });
    expect(tested?.configured).toEqual([]);
  });

  it("reads the thinking levels a session on the provider and model lists, once", async () => {
    const { fake, setup: goose } = setup({
      thinking: {
        "": { current: "medium", levels: ["off", "low", "medium", "high"] },
        "claude-haiku-5-5": { current: "off", levels: ["off"] },
      },
    });
    expect(
      await goose.efforts({ provider: "anthropic", model: "claude-haiku-5-5" }),
    ).toEqual({ current: "off", levels: ["off"] });
    expect(await goose.efforts({ provider: "anthropic", model: " " })).toEqual({
      current: "medium",
      levels: ["off", "low", "medium", "high"],
    });
    await goose.efforts({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(fake.geese).toHaveLength(2);
    const [read] = fake.geese;
    expect(read?.opened[0]).toMatchObject({
      mcpServers: [],
      _meta: { enabledExtensions: [], provider: "anthropic" },
    });
    // No turn runs, and goose keeps no session for it.
    expect(read?.turns).toEqual([]);
    expect(read?.deleted).toEqual(["session-1"]);
    expect(read?.killed).toBe(true);
  });

  it("refreshes inherited thinking choices after saving defaults and rechecking", async () => {
    const thinking = { "": { current: "low", levels: ["low"] } };
    const { setup: goose } = setup({ thinking });
    const inherited = { provider: "", model: "" };
    expect((await goose.efforts(inherited)).levels).toEqual(["low"]);
    thinking[""] = { current: "high", levels: ["high"] };
    await goose.saveDefaults({ provider: "ollama", model: "qwen3" });
    expect((await goose.efforts(inherited)).levels).toEqual(["high"]);
    thinking[""] = { current: "off", levels: ["off"] };
    await goose.check();
    expect((await goose.efforts(inherited)).levels).toEqual(["off"]);
  });

  it("reads no thinking levels from a goose that lists none", async () => {
    const { setup: goose } = setup();
    expect(await goose.efforts({ provider: "", model: "" })).toEqual({
      current: "",
      levels: [],
    });
  });

  it("says when the bundled goose-acp is missing", async () => {
    const fake = fakeSpawn();
    const spawn: Spawn = async (id, options) => {
      if (id === "goose")
        throw new Error(
          "Could not start goose-acp: No such file or directory (os error 2)",
        );
      return fake.spawn(id, options);
    };
    const goose = new GooseSetup({ ...fake, spawn });
    await expect(goose.providers()).rejects.toThrow("goose-acp is missing");
    expect(await goose.test({ provider: "", model: "" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("goose-acp is missing"),
    });
  });
});

describe("keyLabel", () => {
  it("names a key by what follows the provider", () => {
    expect(keyLabel("ANTHROPIC_API_KEY")).toBe("API key");
    expect(keyLabel("OLLAMA_HOST")).toBe("Host");
    expect(keyLabel("AZURE_OPENAI_ENDPOINT_URL")).toBe("Openai endpoint URL");
    expect(keyLabel("TOKEN")).toBe("Token");
  });
});

it("checks Goose config readiness and writes defaults through Goose", async () => {
  const { setup: goose, fake } = setup();
  await goose.check();
  expect(goose.snapshot().readiness).toBe("ready");
  await goose.saveDefaults({ provider: "ollama", model: "llama4" });
  expect((await goose.providers()).defaults).toEqual({
    provider: "ollama",
    model: "llama4",
  });
  expect(goose.snapshot()).toMatchObject({
    readiness: "ready",
    blocking: false,
  });
  expect(fake.geese.every((process) => process.killed)).toBe(true);
});

it("requires a configured default provider and recovers after setup", async () => {
  const { setup: goose } = setup({ defaults: {} });
  await goose.check();
  expect(goose.snapshot().readiness).toBe("attention");
  await goose.saveDefaults({ provider: "ollama", model: "" });
  expect(goose.snapshot().readiness).toBe("ready");
});

it("reports unavailable Goose as needing attention", async () => {
  const goose = new GooseSetup(undefined);
  await goose.check();
  expect(goose.snapshot().readiness).toBe("attention");
  await expect(
    goose.saveDefaults({ provider: "ollama", model: "qwen3" }),
  ).rejects.toThrow();
  expect(goose.snapshot().blocking).toBe(false);
});

it("invalidates runtime defaults only after a successful save", async () => {
  const fake = fakeSpawn({ providers: PROVIDERS });
  const changed = vi.fn();
  const goose = new GooseSetup(fake, changed);
  await goose.check();
  expect(changed).not.toHaveBeenCalled();
  await goose.saveDefaults({ provider: "ollama", model: "qwen3" });
  expect(changed).toHaveBeenCalledTimes(1);
  const unavailable = new GooseSetup(undefined, changed);
  await expect(
    unavailable.saveDefaults({ provider: "ollama", model: "" }),
  ).rejects.toThrow();
  expect(changed).toHaveBeenCalledTimes(1);
});

it("blocks dismissal throughout credential persistence and clears blocking on failure", async () => {
  const { setup: goose } = setup();
  await goose.check();
  let reject!: (reason: Error) => void;
  const gate = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const save = vi.spyOn(goose, "save").mockReturnValue(gate);
  const pending = goose.saveDefaults(
    { provider: "ollama", model: "qwen3" },
    { OLLAMA_HOST: "host" },
  );
  const result = expect(pending).rejects.toThrow("key failure");
  try {
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
    expect(goose.snapshot().blocking).toBe(true);
  } finally {
    reject(new Error("key failure"));
  }
  await result;
  expect(goose.snapshot().blocking).toBe(false);
});

it("invalidates inherited sessions when a fresh check finds external defaults changes", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "ollama", modelId: "qwen3" },
  });
  const changed = vi.fn();
  const goose = new GooseSetup(fake, changed);
  await goose.check();
  await new GooseSetup(fake).saveDefaults({
    provider: "ollama",
    model: "llama4",
  });
  await goose.check();
  expect(changed).toHaveBeenCalledTimes(1);
  await goose.check();
  expect(changed).toHaveBeenCalledTimes(1);
});

it("retains the stored provider model when a defaults save omits the model", async () => {
  const { setup: goose } = setup();
  await goose.saveDefaults({ provider: "ollama", model: "llama4" });
  await goose.saveDefaults({ provider: "ollama", model: "" });
  expect((await goose.providers()).defaults).toEqual({
    provider: "ollama",
    model: "llama4",
  });
});

it("saves the catalog model when switching to a provider without a stored model", async () => {
  const { setup: goose, fake } = setup({
    providers: PROVIDERS.map((provider) => ({ ...provider, configured: true })),
  });
  await goose.saveDefaults({ provider: "anthropic", model: "" });
  expect((await goose.providers()).defaults).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
  expect(
    fake.geese
      .flatMap((process) => process.received)
      .find((request) => request.method === "_goose/unstable/defaults/save")
      ?.params,
  ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5" });
  expect(goose.snapshot().readiness).toBe("ready");
});

it("does not report ready when a configured provider has no model", async () => {
  const { setup: goose } = setup({ defaults: { providerId: "ollama" } });
  await goose.check();
  expect(goose.snapshot().readiness).toBe("attention");
});

it("rejects a provider without a default model before changing defaults", async () => {
  const { setup: goose, fake } = setup();
  await expect(
    goose.saveDefaults({ provider: "databricks", model: "" }),
  ).rejects.toThrow("Choose a default model");
  expect(
    fake.geese
      .flatMap((process) => process.received)
      .some((request) => request.method === "_goose/unstable/defaults/save"),
  ).toBe(false);
  expect((await goose.providers()).defaults).toEqual({
    provider: "ollama",
    model: "qwen3",
  });
  expect(goose.snapshot().blocking).toBe(false);
});

it("preserves a provider's custom model when switching away and back after restart", async () => {
  const { setup: goose, fake } = setup({
    providers: PROVIDERS.map((provider) => ({ ...provider, configured: true })),
    defaults: { providerId: "ollama", modelId: "custom-model" },
  });
  await goose.saveDefaults({ provider: "anthropic", model: "" });
  const restarted = new GooseSetup(fake);
  await restarted.saveDefaults({ provider: "ollama", model: "" });
  expect((await restarted.providers()).defaults).toEqual({
    provider: "ollama",
    model: "custom-model",
  });
  expect(restarted.snapshot().readiness).toBe("ready");
  expect(
    fake.geese
      .flatMap((process) => process.received)
      .filter((request) => request.method === "_goose/unstable/config/read")
      .every(
        (request) =>
          request.params?.key === "providers" &&
          request.params?.isSecret === false,
      ),
  ).toBe(true);
});
