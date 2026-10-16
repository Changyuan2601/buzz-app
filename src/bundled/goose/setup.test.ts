import { describe, expect, it } from "vitest";
import type { Spawn } from "./goose";
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
  return { fake, setup: new GooseSetup(fake.spawn) };
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

  it("reads no thinking levels from a goose that lists none", async () => {
    const { setup: goose } = setup();
    expect(await goose.efforts({ provider: "", model: "" })).toEqual({
      current: "",
      levels: [],
    });
  });

  it("says when the bundled goose-acp is missing", async () => {
    const spawn: Spawn = async (id, options) => {
      if (id === "goose")
        throw new Error(
          "Could not start goose-acp: No such file or directory (os error 2)",
        );
      return fakeSpawn().spawn(id, options);
    };
    const goose = new GooseSetup(spawn);
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
