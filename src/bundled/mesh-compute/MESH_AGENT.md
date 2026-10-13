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
  (`_goose/unstable/session/system-prompt/set`, mode `append`).

## Replies (per agent, Settings → "Reply with Buzz tools")

- **On (default):** like Codex and Claude Code, the model gets the shared Buzz
  tools `send` and `read` (`src/buzz-mcp/tools.ts`), executed in the plugin via
  `appClient`, signed by Agents' host signer; goose never holds a key. A
  `send` with `final: true` ends the turn. If the turn never calls `send`, its
  text is posted as the reply.
- **Off:** goose's final text is posted as one reply (suits small models).

Bridge: goose only spawns stdio MCP servers, so the plugin declares
`nc -U /tmp/buzz-mesh-<random>.sock` as the `buzz` server and holds the other
end through a declared `nc -lU` process. macOS only for now.

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
- Windows/Linux: not bundled; the `nc` bridge is macOS-only.
- Triggering verified only for explicit owner mentions.
