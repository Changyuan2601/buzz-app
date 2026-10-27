# Agent hook callbacks

Plugins register callbacks with `ctx.agents.registerHook({ id, harness, event, run })`. The `harness` is an agent type key, such as `buzz.claude-code/claude-code`, `buzz.codex/codex` or `buzz.pi/pi`. Declare that exact key in `host.agentHooks` in the plugin manifest. Installation access review discloses that the plugin can observe hook events and change or block agent actions. These trusted plugins are not sandboxed.

Core owns plugin registration and lifetime, not a common event schema. Each harness adapter owns its event names, input and response formats. `run(input, { agent, session })` receives native input separately from routing supplied by the adapter. Never infer the Buzz agent's identity or successful actions from fields inside `input`.

The installed native dispatcher is fixed. Every event looks up the currently active plugin callbacks, ordered by plugin ID and registration ID. Enabling, disabling or replacing a plugin changes later events without restarting harness processes. A callback already running is not cancelled by unloading its plugin. Each event shares a 25-second callback budget (2.5 seconds for Codex Interrupt), below its native deadline. A throwing callback is logged and later callbacks are still evaluated in order. If none decides, callback errors propagate to the harness; deadline exhaustion also fails the dispatch. Claude and Codex continue an action after hook failure, while Pi rejects it. A timed-out callback is not cancelled, but no later callback starts after the dispatch deadline.

## Claude

Claude callbacks use its SDK control channel. Events are `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd` and `Notification`. Input and output use Claude's native hook schema. Return `undefined` or `{}` to observe without deciding. The first nonempty response wins. Buzz's existing final-send callback remains separate.

## Codex

Codex installs fixed native MCP hooks and a separate authenticated endpoint for each admitted thread. The endpoint is not advertised as a model tool. It is bound to the agent by its closure and to the native thread ID at admission. This transport does not make callback input proof that an action occurred; callbacks must not manufacture verified Buzz completions.

Events are `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionStart` and `Interrupt`. Codex does not support SessionEnd MCP hooks. Interrupt has a native three-second deadline; the other dispatchers use 30 seconds. The adapter projects `session_id`, `cwd`, `hook_event_name`, `transcript_path`, and the event's principal fields through Codex's native argument templates. Tool events include `tool_name` and `tool_input`; pre/post tool events include `tool_use_id`, and post tool events include `tool_response`. Prompt events include `prompt`, stop includes `stop_hook_active` and `last_assistant_message`, compaction includes `trigger`, and session start includes `source`. Outputs use Codex's native response schema. Return `undefined` or `{}` to continue to the next callback; the first nonempty response wins.

Trust for Buzz's dispatcher stays in thread configuration and does not change saved user hook trust. Buzz enables native hooks for its Codex threads unless Codex configuration explicitly sets `features.hooks = false` (or the legacy `features.codex_hooks = false`). An explicit `features.hooks` value takes precedence over the legacy spelling. That opt-out disables the callback bridge too. Otherwise the user's own trusted hooks also run under Codex's settings, independently of plugin registrations. Title generation disables Buzz's dispatcher. Plugin changes do not replace the shared Codex process, terminate titles or background terminals, or disable unrelated registered callbacks while a terminal runs.

## Pi

Pi uses its existing host RPC to expose Pi durable's `beforeTool` and `afterTool`. `beforeTool` receives the native call and may return `{ block: "reason" }` or `{ arguments: { ... } }`. `afterTool` receives `{ call, result }` and may return the replacement native `ToolExecutionResult`. Return `undefined` to leave the event unchanged. The first defined response wins. The conversation ID and agent identity come from Pi's host, independently of tool arguments.

Local Pi durable packages remain supported separately, as described in [Pi extensions](../src/bundled/pi/EXTENSIONS.md).
