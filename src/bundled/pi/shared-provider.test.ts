import { expect, it } from "vitest";
import {
  DATABRICKS_ID,
  type SharedProvider,
} from "../../features/providers/shared";
import { sharedBinding } from "./shared-provider";

const shared: SharedProvider = {
  id: DATABRICKS_ID,
  name: "Databricks in Buzz",
  connected: async () => true,
  models: async () => [
    {
      id: "databricks-claude-opus-5-5",
      label: "Claude Opus 5.5",
      family: "claude",
      apis: ["anthropic/v1/messages", "openai/v1/responses"],
    },
    {
      id: "databricks-claude-old",
      label: "Claude on Chat only",
      family: "claude",
      apis: ["openai/v1/responses", "openai/v1/chat/completions"],
    },
    {
      id: "databricks-gpt-6",
      label: "GPT-6",
      family: "gpt",
      apis: ["openai/v1/responses", "mlflow/v1/responses"],
    },
    {
      id: "databricks-gemini-4",
      label: "Gemini 4",
      family: "gemini",
      apis: ["openai/v1/responses"],
    },
    {
      id: "databricks-llama",
      label: "Llama",
      family: "llama",
      apis: ["openai/v1/chat/completions"],
    },
  ],
  connection: async () => ({
    host: "https://workspace.example",
    command: "/Applications/Buzz",
    args: ["--databricks-provider-token"],
  }),
  Connection: () => null,
};

it("routes Claude to Anthropic Messages and the rest to Responses, leaving out what Pi can't drive", async () => {
  await expect(sharedBinding(shared, DATABRICKS_ID)).resolves.toEqual({
    name: "Databricks in Buzz",
    command: "/Applications/Buzz",
    args: ["--databricks-provider-token"],
    models: [
      {
        id: "databricks-claude-opus-5-5",
        name: "Claude Opus 5.5",
        api: "anthropic-messages",
        baseUrl: "https://workspace.example/ai-gateway/anthropic",
      },
      {
        id: "databricks-gpt-6",
        name: "GPT-6",
        api: "openai-responses",
        baseUrl: "https://workspace.example/ai-gateway/openai/v1",
      },
    ],
  });
});

it("binds nothing for Pi's own providers, and asks for the plugin when it is off", async () => {
  await expect(sharedBinding(shared, "anthropic")).resolves.toEqual({});
  await expect(sharedBinding(undefined, DATABRICKS_ID)).rejects.toThrow(
    "Enable the Databricks provider plugin first",
  );
});
