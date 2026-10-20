// The agent settings that sync across devices (NIP-AP `buzz.agent.settings`):
// every per-agent setting except instructions, which have their own artifact.
// No credentials or env vars live in this config; the allowlist keeps it so.
import {
  pickSettings,
  type SettingsSchema,
} from "../../features/agents/agent-config";
import type { Config } from "./runtime";

export const syncedSettingsSchema = {
  model: "string",
  effort: "string",
  scope: ["thread", "channel"],
} as const satisfies SettingsSchema;

export const syncedSettings = (config: Config) =>
  pickSettings(syncedSettingsSchema, config);

/** Synced fields override; everything else stays this device's. */
export const withSyncedSettings = (
  config: Config,
  settings: Readonly<Record<string, string>>,
): Config =>
  ({ ...config, ...pickSettings(syncedSettingsSchema, settings) }) as Config;
