# Shared provider plugins for Goose and Pi

Goose and Pi can use several inference providers. Their credentials belong to the selected provider, rather than a single harness account such as the one used by Codex or Claude. A shared provider plugin would let a user configure Databricks or OpenRouter once and use that connection from either agent type.

## Motivation

In the Buzz discussions, Mic asked how general-purpose harnesses could share providers, and baxen proposed configuring credentials once for Goose and Pi. The proposed scope became credentials plus model discovery. This would avoid separate logins and duplicate configuration while giving Buzz one model picker across configured providers. See the [provider registry discussion](buzz://message?channel=099e2481-9499-48d6-adad-fa89a15163a0&id=385f6dae4cdf5e455a3ca506e8c96ee270b86198b053547d47a87587534f2514) and [shared provider proposal](buzz://message?channel=099e2481-9499-48d6-adad-fa89a15163a0&id=0cba713c360bf4b5310cd717df4868e8e6e0b644dfcf69f424645b64da8960ae).

## Scope

Provider integration involves three kinds of work:

1. **Authentication and configuration:** credentials, endpoints, login, and token refresh.

2. **Model discovery:** model IDs, aliases, available API routes, and capabilities.

3. **Inference:** request formatting, streaming, thinking controls, and conversation replay.

Share the first two. Leave inference to each agent plugin’s harness integration. Goose and Pi have different request and history representations; their existing adapters already translate those into provider APIs. The [Pi Databricks extension](https://github.com/squareup/pi-extensions/tree/main/packages/pi-databricks) also contains Pi-specific compatibility fixes that a shared catalog cannot replace.

## Databricks example and boundaries

A user configures **Work Databricks**, signs in once, and chooses a model. The shared plugin supplies the connection and catalog. The Pi integration registers a provider with the routes and compatibility settings of Pi’s Databricks extension; the Goose integration configures a supported Goose provider adapter. Each uses a supported API route and obtains current access tokens from the shared authentication owner.

| Shared Databricks plugin owns | Each agent plugin integration owns |
| --- | --- |
| Workspace configuration and connection identity | Binding an agent to a connection and served model ID |
| Login, credential storage, and token refresh | Obtaining fresh access tokens while sessions remain running |
| Endpoint and alias discovery | Registering the catalog with its harness |
| Available API routes and provider capability facts | Filtering unsupported routes and mapping model and effort choices |
| Shared authentication and discovery status | Request formatting, streaming, history replay, and harness-specific compatibility fixes |

The picker can lead with the model and show “via Work Databricks” underneath. Save the exact connection and served model ID. A model appearing in the shared catalog does not imply that both harnesses support it; each integration must check compatibility.

## First slice: Databricks for Goose

Add one shared connection to Block’s Databricks workspace, with browser login, private local credential storage, token refresh, and discovery. Goose selects that connection and an exact served model ID. Pi follows in the next slice; OpenRouter can follow after that.

Goose’s native Databricks adapter does not accept an external credential callback. For this slice, the Goose integration generates a custom OpenAI adapter configuration with command auth. A small Buzz native helper supplies current access tokens; refresh tokens stay in the provider’s private local storage. File locking serializes refresh across Goose processes. Request formatting and streaming remain in Goose.

Goose uses the gateway’s Responses route. Its Chat route rejects reasoning effort alongside tools for GPT-6 models, and GPT-6.1 Sol always requires reasoning effort. Goose offers a short list of ready, tool-capable endpoints that were verified with its tools: GPT-6 and 6.1, Claude Opus, Sonnet, and Haiku 5.5, GLM 5.3, and Grok 4.7. Gemini rejects Goose’s streaming options, and Gemma rejects a tool-schema keyword. Other models, aliases, workspace configuration, and per-agent thinking controls are deferred; Goose’s own thinking-effort setting applies.

The generated Goose configuration contains no tokens and uses its usual history store. Cancellation applies while waiting for the browser. Once the callback has been accepted, the UI shows “Completing sign-in…” while native code saves the connection.

Try it by enabling Databricks and Goose, opening **Settings → Providers → Databricks**, signing in, then choosing **Databricks in Buzz** in a Goose agent’s provider dialog. Verify a tool-bearing conversation, two agents using the same connection, history after restart, and continued work after token refresh.

## Second slice: Databricks for Pi

The catalog lists every gateway route a ready, tool-capable endpoint serves, and the shared plugin gives agent plugins the helper command that prints a current access token. Pi’s provider list leads with **Databricks in Buzz**; its sign-in is the shared connection, not a key in Pi’s `auth.json`.

Buzz does not load Pi packages, so Pi’s host registers the provider itself instead of loading the Databricks extension. The Pi plugin chooses each model’s route the way the extension does: Anthropic Messages for Claude, OpenAI Responses for other families, and neither for Gemini or models with only a Chat route. The host asks the plugin for that binding when it first needs the provider and again when listing its models, then registers it with pi-ai. Context windows, output limits, and thinking levels come from Pi’s built-in model with the same name, and the extension’s gateway compatibility settings apply. Each request runs the token helper, reusing its answer for 30 seconds. Request formatting, streaming, and history stay in Pi.

Try it by enabling Databricks and Pi, signing in under **Settings → Providers → Databricks** or from the Pi provider dialog, then choosing **Databricks in Buzz** and a Claude and a GPT model in two Pi agents. Verify tool-bearing turns on both routes, a goose and a Pi agent on the same connection, and continued work after token refresh.
