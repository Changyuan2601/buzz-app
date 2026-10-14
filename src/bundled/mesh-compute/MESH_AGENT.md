# Agents "Mesh" type (draft)

Agents → New agent → **Mesh**. A mention from the agent's owner runs one turn
of lean upstream goose on this community's shared compute, in the agent's
workspace (default `~/.buzz`).

## Runtime

- **Binary:** goose's ACP-only `goose-acp` (goose #11961), bundled as
  `Contents/MacOS/buzz-mesh-goose`. Spoken to over ACP on stdio.
- **Inference:** `mesh_compute_prepare_inference` returns the local
  OpenAI-compatible endpoint; goose's `openai` provider is pointed at it
  (`OPENAI_HOST`/`OPENAI_BASE_PATH`/`GOOSE_MODEL`). No provider fallback.
- **goose state:** `GOOSE_PATH_ROOT=~/.local/share/buzz-mesh-goose`, so the
  user's own goose config, extensions and sessions are not used. Session
  naming is off (one model call per turn, not two).
- **Tools:** goose `developer` (`shell`, `write`, `edit`, `tree`,
  `read_image`) and skills (`load_skill`). `extensionmanager` and `summon` are
  switched off. `GOOSE_MODE=auto`: tools run without asking. goose reads
  `AGENTS.md`/hints as it normally does.
- **Prompt:** appended under goose's "Additional Instructions"
  (`_goose/unstable/session/system-prompt/set`, mode `append`). Mesh keeps only
  concise posting/tool guidance, fresh core memory and the agent instructions;
  it does not inject the shared engineering base prompt.

## Modes (per agent, Settings)

- **Chat:** no goose harness or tools. One mesh chat completion is posted as
  a direct reply; intended for small models. Native Chat requests specify
  `reasoning_effort: "none"` so thinking-capable models answer directly rather
  than spend Mesh's route budget on hidden reasoning.
  An owner-configured event watch with exactly `author == "<64-character hex public key>"`
  may also follow that sender's messages, including thread replies. Set the watch's
  channels to where it should listen. Names and Interest instructions do not filter
  senders. Chat receives the matched Interest's instructions for that turn, with
  the watched message as its subject and earlier messages as context. Direct
  mentions do not inherit a previous watch's instructions.
  Broad or compound filters retain owner-only triggering. The agent never
  triggers itself; a one-way follower needs no timer. Keep the source agent's watch
  restricted to the human owner to avoid a reciprocal conversation.
- **Agent (default):** lean goose with workspace tools and skills. With
  **Buzz access** off, its final text is posted through the same direct-reply
  path as Chat.
- **Agent with Buzz access (default on):** also the shared Buzz MCP tools
  (`src/buzz-mcp/tools.ts`), executed in the plugin via `appClient` and signed
  by Agents' host signer; goose never holds a key. Final prose is always posted as the reply. Optional `send` calls neither
  suppress that response nor end the turn. Mesh omits `final` from its send
  schema; the shared tool behavior for other providers is unchanged.

Buzz access uses the app's native relay (`src-tauri/src/tool_relay.rs`) as its
sole Buzz-tool transport. The plugin starts the app with `--tool-listen`;
lean goose starts that same executable with `--tool-relay` as a stdio MCP
server. A private Unix socket and one-time token connect them. The plugin
answers tool calls for the active turn; calls between turns are refused.
No external socket utility or transport fallback is used.

## Build and package

```sh
scripts/mesh-goose/build.sh [/path/to/goose/checkout]   # stages src-tauri/binaries/
bin/pnpm tauri build --features mesh --bundles app \
  --config src-tauri/tauri.mesh.conf.json
```

## Known limitations

- Community switch is not isolated: the lease is re-checked before the
  fallback post, but a switch can restart compute mid-turn, and `send` calls
  made before it are not undone.
- Native relay: Unix only; Windows is unsupported. The build command above
  stages a sidecar for the current Rust host target, not a cross-platform release.
- Release packaging: the sidecar build and mesh Tauri config are explicit steps;
  the current `.github/workflows` do not invoke them. Packaged real-mesh
  acceptance remains required before declaring this path validated.
- Agent turns accept mid-turn steering for the same conversation/configuration;
  a finished run falls back to the next turn. Chat stays sequential.
- Idle sessions close after 15 minutes. App/process restart starts fresh from
  recent Buzz conversation history, not `session/load`. Tool-enabled agents
  receive fresh core memory via the shared agent-harness reader.
- The Transcripts tab reads recent saved sessions through the managed binary,
  without preparing inference. It shows a read-only snapshot (Refresh for new
  activity), up to 50 sessions within five pages and 50 turns per session.
  Older builds did not label sessions with stable agent/place metadata, so their
  sessions are not listed. Chat has no Goose tool transcript.
- Triggering verified only for explicit owner mentions.
