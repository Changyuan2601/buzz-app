import { expect, it, vi } from "vitest";
import { memoryStorage } from "../../features/agents/test-fakes";
import { fakeSpawn } from "./goose-testing";
import { GooseSetup } from "./setup";
import { GooseProvider } from "./provider";
import { DEFAULT_CONFIG } from "./runtime";

it("saves only a tested Goose choice and restores it without replacing explicit per-agent settings", async () => {
  const f = fakeSpawn({ reply: "OK" });
  const storage = memoryStorage();
  const setup = new GooseSetup(f.spawn);
  const provider = new GooseProvider(setup, storage);
  await provider.check();
  expect(provider.snapshot().readiness).toBe("attention");
  await provider.save(
    { provider: "anthropic", model: "chosen" },
    new AbortController().signal,
  );
  expect(provider.snapshot().readiness).toBe("ready");
  expect(provider.resolve(DEFAULT_CONFIG)).toMatchObject({
    provider: "anthropic",
    model: "chosen",
  });
  const restored = new GooseProvider(setup, storage);
  expect(restored.resolve(DEFAULT_CONFIG)).toMatchObject({
    provider: "anthropic",
    model: "chosen",
  });
  expect(
    restored.resolve({ ...DEFAULT_CONFIG, provider: "ollama" }),
  ).toMatchObject({ provider: "ollama", model: "" });
});

it("does not save or report connected when the selected provider refuses the connection test", async () => {
  const f = fakeSpawn({ reply: "Invalid key" });
  const storage = memoryStorage();
  const provider = new GooseProvider(new GooseSetup(f.spawn), storage);
  await provider.check();
  await expect(
    provider.save(
      { provider: "anthropic", model: "chosen" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Invalid key");
  expect(provider.snapshot()).toMatchObject({ readiness: "attention" });
  expect(provider.snapshot().blocking).toBeUndefined();
  expect(provider.choice()).toEqual({ provider: "", model: "" });
});

it("cancels a connection attempt without changing the selected provider", async () => {
  const f = fakeSpawn({ hold: true });
  const storage = memoryStorage();
  const provider = new GooseProvider(new GooseSetup(f.spawn), storage);
  await provider.check();
  const controller = new AbortController();
  const pending = provider
    .save({ provider: "anthropic", model: "chosen" }, controller.signal)
    .catch((error) => error);
  await vi.waitFor(() =>
    expect(f.geese.some((goose) => goose.turns.length)).toBe(true),
  );
  expect(provider.snapshot().blocking).toBe(true);
  controller.abort();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(provider.snapshot().blocking).toBeUndefined();
  expect(provider.choice()).toEqual({ provider: "", model: "" });
  expect(f.geese.every((goose) => goose.killed)).toBe(true);
});
