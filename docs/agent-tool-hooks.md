# Native agent hooks

Plugins supply native hook configuration through `ctx.agents.registerNativeHooks({ id, harness, hooks })`, where `harness` is `claude-code` or `codex` and `hooks` is the native event table. Buzz merges active plugin contributions and preserves native event names and fields. The harness validates configuration and runs handlers.

Plugins manage their own handlers, servers, state and policy. A native command can forward events to a plugin-owned server and return its response. Commands run with the agent privileges, outside the plugin host process declarations. Use each harness native schema and response format.

Claude receives configuration through `--settings`; it participates in spare and session fingerprints. Codex receives process-local configuration flags, with thread-local trust for those flags. Saved user hook trust is unchanged. Title threads disable contributed hooks. Configuration changes apply to new Claude sessions and the next idle Codex server generation, preserving active turns and compaction. Disabling a plugin does not cancel commands already running.

Codex TOML configuration cannot represent JSON null values. Existing sessions from a build without these adapters need a restart after updating Buzz. Plugins using this contribution require the matching host build.
