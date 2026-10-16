// The owner's device-wide Codex defaults, which an agent's blank model and
// thinking inherit. The app's provider dialog saves them in agent storage; the
// app and the standalone agent host resolve an agent's settings with them.
import type { AgentStore } from "../../features/agents/state";
import { type Config, config, type Model, resolveModel } from "./config";

export type ProviderDefaults = Readonly<{ model: string; effort: string }>;
export const DEFAULTS_KEY = "buzz.codex.provider-defaults.v1";
const NATIVE: ProviderDefaults = Object.freeze({ model: "", effort: "" });

/** The saved defaults; Codex's own, blank, when none are saved or they are
 * malformed. */
export function readDefaults(
  storage: Pick<AgentStore, "get">,
): ProviderDefaults {
  try {
    const value: unknown = JSON.parse(storage.get(DEFAULTS_KEY) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      (value as { version?: unknown }).version === 1 &&
      typeof (value as { model?: unknown }).model === "string" &&
      typeof (value as { effort?: unknown }).effort === "string"
    )
      return Object.freeze({
        model: config(value).model,
        effort: (value as { effort: string }).effort,
      });
  } catch {
    // Malformed local preferences follow Codex's recommendation.
  }
  return NATIVE;
}

/** An agent's settings: its own model and thinking, else the defaults'.
 * With Codex's `models`, a default model it no longer lists, and thinking the
 * model does not support, fall back to Codex's choice. */
export function resolveConfig(
  raw: unknown,
  defaults: ProviderDefaults,
  models?: readonly Model[],
): Config {
  const find = (model: string) => {
    if (!models) return undefined;
    const resolved = resolveModel(model, models);
    return models.find((choice) => choice.model === resolved);
  };
  const explicit = config(raw);
  const inheritedModel = defaults.model;
  const unavailable = Boolean(
    inheritedModel && models && !find(inheritedModel),
  );
  const model = explicit.model || (unavailable ? "" : inheritedModel);
  if (explicit.effort) return { ...explicit, model };
  const selected = find(model);
  const preferred = unavailable && !explicit.model ? "" : defaults.effort;
  const effort = !preferred
    ? ""
    : !models
      ? preferred
      : selected?.supportedReasoningEfforts.some(
            (choice) => choice.reasoningEffort === preferred,
          )
        ? preferred
        : (selected?.defaultReasoningEffort ?? "");
  return { ...explicit, model, effort };
}
