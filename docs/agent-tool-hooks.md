# Agent hooks

External plugins can supply native hook JSON and live callbacks for Claude and Codex. The plugin owns hook behavior; the harness adapter owns native protocol translation.

## Native configuration

Pass the event table from a harness's `hooks.json` through `ctx.agents.registerNativeHooks({ id, harness, hooks: hooksJson.hooks })`. The harness validates event definitions, runs commands, sends their JSON stdin and consumes stdout. Buzz preserves unknown event names and fields. Use each harness's native schema. Commands run with the agent's privileges, outside the plugin's confined `host.processes` declarations.

## Callbacks

Register a callback for any native event name:

```ts
ctx.agents.registerHook({
  id: "prompt-context",
  harness: "claude-code",
  event: "UserPromptSubmit",
  run: ({ input }) => ({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Plugin-provided context",
    },
  }),
});
```

The callback receives `event`, the harness's `input`, and Buzz facts separately: `agent`, `session`, `messages`, `context` and `source`. Return the native harness response object. Buzz does not translate a plugin policy into a shared denial format or enumerate which native events a plugin may use. Registrations follow active plugin revisions and Cordis disposal. Callbacks on a running definition consult the currently active registration. Changes to callback definitions apply when Claude next starts a session or Codex next opens an idle server generation.

Claude callbacks receive the complete SDK input. Codex callbacks also declare an `input` object using Codex's native MCP interpolation, for example `{ session_id: "${session_id}", tool_name: "${tool_name}" }`. That object determines what Codex sends to the callback; it is not a copy of every field in its command-hook stdin. An early callback can identify its agent before the thread has been attached to a conversation, so `messages` and `context` may be empty.

`source: "harness"` identifies a native callback. Codex MCP tools can also be invoked by the model, so their arguments are not evidence that a tool completed. For Buzz tools, Codex emits verified `PreToolUse`, `PostToolUse` and `PostToolUseFailure` observations with `source: "host"`. Set a registration's `source` to limit it to either path; omitting it accepts both. Host observations use native input field names, such as `tool_use_id`, `tool_name` and `tool_input`. Codex dynamic Buzz tool names have the form `buzzsend`. Native matchers filter native callbacks; host observations match against the same tool name using JavaScript regular expressions.

A stateful plugin retains its pre-call message snapshot until the matching successful completion. A send already in flight must not acknowledge a later mention. Each admitted message includes its signed audience and an `authorIsAgent` profile hint, not authorization evidence. Wakes and standalone Attention turns have no admitted mention obligation.

The external Reply first plugin uses this callback API. It owns reply decisions, settings and snapshots; it accepts Codex send completions only from the host observation path. There is no tool-specific registration API or compatibility shim.

## Lifecycle and limits

Claude receives native command hooks through `--settings` and callbacks through its SDK initialization alongside Buzz's final-send callback. Native command configuration participates in spare/session fingerprints. Codex receives native commands and callback definitions through process-local flags, with an authenticated MCP transport per thread. Only Buzz-supplied flag definitions receive thread-local trust; saved user hook trust is untouched. Title threads disable contributed hooks. Plugin changes preserve active turns and compaction, taking effect on the next idle server generation. Disabling a plugin does not cancel commands already running.

Codex's native MCP transport errors fail open. Callbacks are conversational guardrails, not a sandbox or latency guarantee. Its TOML configuration cannot represent JSON null values, which fail configuration rather than being silently changed. Existing sessions from a build without these adapters need a restart after updating Buzz. A plugin using this API requires the matching host build.
