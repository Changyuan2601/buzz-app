import { expect, it, vi } from "vitest";
import { fakeSpawn } from "./goose-testing";
import { DEFAULT_CONFIG } from "./runtime";
import { suggestNames } from "./name-ideas";

it("gets names from the selected Goose provider with no extensions and deletes the scratch session", async () => {
  const f = fakeSpawn({
    reply: '["Welcome", "Taken", "Quibble", "quibble", "Tumble"]',
  });
  expect(
    await suggestNames(
      f.spawn,
      { ...DEFAULT_CONFIG, provider: "openai", model: "chosen" },
      ["Taken"],
      new AbortController().signal,
    ),
  ).toEqual(["Quibble", "Tumble"]);
  expect(f.geese[0]?.env).toMatchObject({ GOOSE_MODE: "chat" });
  expect(f.geese[0]?.configured).toEqual(["session-1 model=chosen"]);
  expect(f.geese[0]?.opened[0]).toMatchObject({
    mcpServers: [],
    _meta: { enabledExtensions: [], provider: "openai" },
  });
  expect(f.geese[0]?.deleted).toEqual(["session-1"]);
  expect(f.geese[0]?.killed).toBe(true);
  expect(f.servers).toEqual([]);
});

it("cancels a held Goose request without returning names or leaving its process alive", async () => {
  const f = fakeSpawn({ hold: true });
  const controller = new AbortController();
  const result = suggestNames(
    f.spawn,
    DEFAULT_CONFIG,
    [],
    controller.signal,
  ).catch((error) => error);
  await vi.waitFor(() => expect(f.geese[0]?.turns).toHaveLength(1));
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(f.geese[0]?.killed).toBe(true);
});
