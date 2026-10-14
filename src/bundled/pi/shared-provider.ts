// Pi maps a shared connection to a provider its host registers. The plugin
// picks each model's route on the gateway; request formatting, streaming and
// replay stay in Pi, and no refresh token leaves Buzz.
import {
  DATABRICKS_ID,
  type ProviderModel,
  type SharedProvider,
} from "../../features/providers/shared";
import type { Binding } from "./pi";

/** A model's route on Databricks AI Gateway, as Pi's Databricks extension
 * chooses it: Anthropic Messages for Claude, OpenAI Responses for the rest.
 * Gemini and Chat Completions routes need fixes of their own, so those
 * models are not offered. */
const route = (host: string, model: ProviderModel) => {
  if (model.family === "claude")
    return model.apis.includes("anthropic/v1/messages")
      ? {
          api: "anthropic-messages" as const,
          baseUrl: `${host}/ai-gateway/anthropic`,
        }
      : undefined;
  return model.family !== "gemini" && model.apis.includes("openai/v1/responses")
    ? {
        api: "openai-responses" as const,
        baseUrl: `${host}/ai-gateway/openai/v1`,
      }
    : undefined;
};

/** The shared provider `id` for the Pi host, or nothing for one Buzz doesn't
 * share. */
export async function sharedBinding(
  shared: SharedProvider | undefined,
  id: string,
): Promise<Binding> {
  if (id !== DATABRICKS_ID) return {};
  if (!shared) throw new Error("Enable the Databricks provider plugin first");
  const [models, { host, command, args }] = await Promise.all([
    shared.models(),
    shared.connection(),
  ]);
  return {
    name: shared.name,
    command,
    args,
    models: models.flatMap((model) => {
      const found = route(host, model);
      return found ? [{ id: model.id, name: model.label, ...found }] : [];
    }),
  };
}
