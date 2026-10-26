# Agent tool hooks

External plugins inject `agents` and register a live policy with `ctx.agents.registerToolHook({ id, run })`. Registrations follow the plugin's active revision and Cordis lifetime. Disable or unload the plugin to remove its enforcement without replacing harness sessions.

`run(event)` returns a denial reason for a `before` event, or `undefined` to continue. Throwing before a tool denies it. After events are observational; throwing there is logged. The hook receives agent and harness-session identities, a call ID, tool name, input, default destination, and the admitted mention snapshot. An after event retains the before snapshot so a successful call cannot acknowledge a mention delivered while it was in flight. Each mention includes its signed message audience and an `authorIsAgent` profile hint, so plugins can exempt agent coordination. The profile hint uses the sender profile already read for the conversation and is not authorization evidence. Plugin wakes and standalone attention turns are not mentions.

Claude's SDK callbacks cover native and Buzz tools, including failed completions. Codex's native pre-tool hooks use an authenticated host MCP server. Buzz dynamic-tool completion is observed directly in the runtime, so a model cannot forge a successful completion by calling the MCP hook tool. Dynamic Buzz tool names are normalized as `mcp__buzz__NAME`. Codex emits after events for Buzz tools; it does not currently expose native-tool completions through this adapter.

Each Codex thread start or resume gets its own host MCP transport, including ephemeral wake and title threads. Unsubscribing releases that transport; closing the app-server releases any that remain.

Codex's process-local bridge definition is checked with `hooks/list`. Only that exact definition receives trust in thread configuration. User hook trust is never bypassed or written. A Codex version that cannot register the bridge fails session preparation. Native MCP hook transport errors are fail-open in Codex itself, so this feature is a conversational guardrail, not a sandbox. The host also evaluates Buzz dynamic tools directly.

The bridge is installed when a session starts. Sessions running an older Buzz build need a one-time restart after updating. Policy changes and plugin settings are read on each call. Ordering tools does not place a time limit on model reasoning or guarantee response latency.

The reply-first policy belongs to the separate external plugin, rather than the host API. It exempts agent senders and agents-only messages, and only releases pending human mentions after a successful public send in their conversation.

## Native hook configuration

A trusted external plugin can pass its native `hooks.json` event table to either harness:

```ts
ctx.agents.registerNativeHooks({
  id: "voice",
  harness: "claude-code", // or "codex", using that harness's native schema
  hooks: hooksJson.hooks,
});
```

Buzz concatenates contributions for each event in contribution-key order and preserves event names and entries. The harness validates the native schema, runs commands, sends their stdin, and consumes their stdout. New harness events do not need a Buzz callback implementation. Commands run with the agent's privileges, like tools contributed by trusted plugins; this API does not confine commands to `host.processes`. Use absolute command paths when the executable is not on the harness's PATH.

Claude receives native hooks through `--settings`, alongside Buzz's SDK tool and final-send callbacks. Native configuration participates in session and spare-process fingerprints. Codex receives native hooks through process-local flags, merged with Buzz's pre-tool bridge. Only definitions from those flags receive thread-local trust. User hook trust remains untouched. Background title threads disable contributed native hooks. Codex's TOML configuration cannot represent JSON null values, so those fail configuration instead of being silently changed.

Registration follows plugin revision and unload. Changed Claude hooks apply when a session next starts. Codex replaces its shared server on the next use after it is idle; it keeps the current configuration while turns or title threads are active. Disabling a plugin removes future contributions, and does not cancel commands or turns already running.
