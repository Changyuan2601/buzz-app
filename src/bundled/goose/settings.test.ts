import { expect, it } from "vitest";
import {
  settingsProblem,
  syncedSettings,
} from "../../features/agents/agent-config";
import {
  syncedSettings as claude,
  syncedSettingsSchema as claudeSchema,
  withSyncedSettings as claudeWithSynced,
} from "../claude-code/settings";
import {
  syncedSettings as codex,
  syncedSettingsSchema as codexSchema,
  withSyncedSettings as codexWithSynced,
} from "../codex/settings";
import { DEFAULT_CONFIG as gooseDefaults } from "./runtime";
import {
  syncedSettings as goose,
  syncedSettingsSchema as gooseSchema,
  withSyncedSettings,
} from "./settings";

it("syncs every agent setting except instructions and the device-local folder", () => {
  const base = {
    model: "m",
    effort: "high",
    instructions: "secret plan",
    workspace: "~/w",
    scope: "thread" as const,
  };
  expect(claude(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(codex(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(goose({ ...gooseDefaults, provider: "p", instructions: "x" })).toEqual(
    {
      model: "",
      provider: "p",
      scope: "thread",
    },
  );
  for (const [schema, settings] of [
    [claudeSchema, claude(base)],
    [codexSchema, codex(base)],
    [gooseSchema, goose(gooseDefaults)],
  ] as const)
    expect(settingsProblem(schema, settings)).toBeUndefined();
});

it("applies only allowlisted synced fields over local config", () => {
  const local = { ...gooseDefaults, instructions: "mine" };
  expect(
    withSyncedSettings(local, {
      model: "m2",
      instructions: "theirs",
      workspace: "/srv",
    }),
  ).toEqual({ ...local, model: "m2" });
});

it("rejects a remote workspace setting as an unknown key for every agent type", () => {
  for (const [agentType, schema] of [
    ["claude-code", claudeSchema],
    ["codex", codexSchema],
    ["goose", gooseSchema],
  ] as const) {
    const content = JSON.stringify({
      version: 1,
      agentType,
      settings: { workspace: "~/w" },
    });
    expect(syncedSettings(content, agentType, schema)).toEqual({
      problem: 'Unknown setting "workspace"',
    });
  }
});

it.each([
  ["goose", withSyncedSettings, { provider: "" }],
  ["claude-code", claudeWithSynced, { effort: "" }],
  ["codex", codexWithSynced, { effort: "" }],
] as const)(
  "%s defaults synced settings an accepted revision leaves out, never keeping this device's",
  (_, merge, unset) => {
    const local = {
      model: "local-model",
      provider: "local-provider",
      effort: "high",
      instructions: "local text",
      workspace: "~/w",
      scope: "channel" as const,
    };
    expect(merge(local as never, { model: "accepted-model" })).toEqual({
      ...local,
      ...unset,
      model: "accepted-model",
      scope: "thread",
    });
  },
);
