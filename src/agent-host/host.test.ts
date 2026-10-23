// @vitest-environment node
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../bundled/claude-code/runtime";
import { defaults as codexDefaults } from "../bundled/codex/config";
import type { AgentIdentity } from "../features/agents/native";
import { fileStore } from "../features/agents/state";
import { changed, claudeResolver, codexResolver } from "./host";

it("resolves blank settings from the owner's saved defaults, as they are now", async () => {
  const storage = fileStore(new Map(), async () => {});
  const claude = claudeResolver(storage);
  const codex = codexResolver(storage);
  // Without saved defaults, the CLI's own.
  expect(claude(DEFAULT_CONFIG).model).toBe("");
  expect(codex(codexDefaults)).toMatchObject({ model: "", effort: "" });
  // The app saves defaults while the host runs.
  await storage.set(
    "buzz.claude-code.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "sonnet" }),
  );
  await storage.set(
    "buzz.codex.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "gpt-5", effort: "high" }),
  );
  expect(claude(DEFAULT_CONFIG).model).toBe("sonnet");
  expect(codex(codexDefaults)).toMatchObject({
    model: "gpt-5",
    effort: "high",
  });
  // An agent's own choice wins.
  expect(claude({ ...DEFAULT_CONFIG, model: "opus" }).model).toBe("opus");
  expect(codex({ ...codexDefaults, model: "o3", effort: "low" })).toMatchObject(
    { model: "o3", effort: "low" },
  );
});

it("stops when the app deletes, erases or changes the agent", () => {
  const agent: AgentIdentity = {
    pubkey: "a".repeat(64),
    relay: "wss://relay.example.test",
    owner: "b".repeat(64),
    type: "buzz.claude-code/claude-code",
    name: "Ada",
    deleted: false,
  };
  expect(changed(agent, [{ ...agent, name: "Renamed" }])).toBeUndefined();
  for (const saved of [
    [],
    [{ ...agent, deleted: true }],
    [{ ...agent, deleting: true as const }],
  ])
    expect(changed(agent, saved)).toBe(
      "The agent is no longer saved on this machine",
    );
  expect(changed(agent, [{ ...agent, type: "buzz.codex/codex" }])).toBe(
    "The agent's type changed on this machine",
  );
  expect(changed(agent, [{ ...agent, owner: "c".repeat(64) }])).toBe(
    "The agent's owner changed on this machine",
  );
});
