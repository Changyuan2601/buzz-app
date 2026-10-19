// The part of the Codex agent type that runs agents, without its views: the
// desktop app registers it with its tabs, and a standalone host runs it alone.
import { syncedSettingsSchema, withSyncedSettings } from "./settings";
import type { AgentType } from "../../features/agents/service";
import type { Config } from "./config";
import type { CodexRuntime } from "./runtime";

export const TYPE_ID = "codex";
/** A turn's run returns once Codex has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

/** How agents of this type run on `runtime`, each turn once `ready`, which
 * can wait out a download of Codex or a check that it is signed in, until
 * `signal` stops the turn. */
export const codexRun = (
  runtime: CodexRuntime,
  ready?: (signal: AbortSignal) => Promise<void>,
): Pick<
  AgentType<Config>,
  "models" | "run" | "runOnce" | "timeoutMs" | "syncedSettings"
> => ({
  models: (agent) => runtime.preview(agent),
  run: async (delivery) => {
    // Before setup can wait, so a Save during it isn't pinned over.
    const restarts = runtime.fence(delivery.agent.pubkey);
    await ready?.(delivery.signal);
    return runtime.run(delivery, restarts);
  },
  runOnce: async (turn) => {
    await ready?.(turn.signal);
    return runtime.runOnce(turn);
  },
  timeoutMs: HANDOVER_MS,
  syncedSettings: {
    schema: syncedSettingsSchema,
    withSynced: withSyncedSettings,
  },
});
