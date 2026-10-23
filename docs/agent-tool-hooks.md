# Agent tool hooks

External plugins inject `agents` and register a live policy with `ctx.agents.registerToolHook({ id, run })`. Registrations follow the plugin's active revision and Cordis lifetime. Disable or unload the plugin to remove its enforcement without replacing harness sessions.

`run(event)` returns a denial reason for a `before` event, or `undefined` to continue. Throwing before a tool denies it. After events are observational; throwing there is logged. The hook receives agent and harness-session identities, a call ID, tool name, input, default destination, and the admitted mention snapshot. An after event retains the before snapshot so a successful call cannot acknowledge a mention delivered while it was in flight. Plugin wakes and standalone attention turns are not mentions.

Claude's SDK callbacks cover native and Buzz tools, including failed completions. Codex's native pre-tool hooks use an authenticated host MCP server. Buzz dynamic-tool completion is observed directly in the runtime, so a model cannot forge a successful completion by calling the MCP hook tool. Dynamic Buzz tool names are normalized as `mcp__buzz__NAME`. Codex emits after events for Buzz tools; it does not currently expose native-tool completions through this adapter.

Codex's process-local bridge definition is checked with `hooks/list`. Only that exact definition receives trust in thread configuration. User hook trust is never bypassed or written. A Codex version that cannot register the bridge fails session preparation. Native MCP hook transport errors are fail-open in Codex itself, so this feature is a conversational guardrail, not a sandbox. The host also evaluates Buzz dynamic tools directly.

The bridge is installed when a session starts. Sessions running an older Buzz build need a one-time restart after updating. Policy changes and plugin settings are read on each call. Ordering tools does not place a time limit on model reasoning or guarantee response latency.

The reply-first policy belongs to the separate external plugin, rather than the host API. It only releases pending mentions after a successful public send in their conversation.
