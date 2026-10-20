// The part of the goose agent type that runs agents, without its views.
import type { AgentType } from "../../features/agents/service";
import type { Config, GooseRuntime } from "./runtime";
import { syncedSettingsSchema, withSyncedSettings } from "./settings";

/** A turn's run returns once goose has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`. */
export const gooseRun = (
  runtime: GooseRuntime,
): Pick<
  AgentType<Config>,
  "run" | "runOnce" | "timeoutMs" | "syncedSettings"
> => ({
  run: (delivery) => runtime.run(delivery),
  runOnce: (turn) => runtime.runOnce(turn),
  timeoutMs: HANDOVER_MS,
  syncedSettings: {
    schema: syncedSettingsSchema,
    withSynced: withSyncedSettings,
  },
});
