# Agents "Mesh" type (draft)

Agents → New agent → **Mesh**. Its only setting is the prompt. A mention
from the agent's owner runs one inference-only turn: the plugin prepares the
shared-compute target natively (`mesh_compute_prepare_inference`), spawns the
GDK `buzz-agent` helper as host process `buzz-mesh-agent`, speaks ACP over
stdio with no MCP servers, and publishes the reply through Agents
(`agent.publish`). No tools, no provider fallback.

## Helper (pinned, bundled)

The helper is a separate pin from the app's bundled `buzz-agent` CLI/ACP: the
goose-core `buzz-agent` (`block/buzz` `micn/buzz-agent-goose-core` at
`6a7c51a5a9367c9e868c6a2cff5706c8a061cf28`) plus
`scripts/mesh-helper/acp-session-id.patch` (ACP session id on every wire
update; not yet on a remote branch). Build and package:

```sh
scripts/mesh-helper/build.sh /path/to/block/buzz   # stages src-tauri/binaries/
bin/pnpm tauri build --features mesh --bundles app \
  --config src-tauri/tauri.mesh.conf.json
```

On aarch64-apple-darwin the helper builds to sha256
`92ab64496b85d28fa163045860e9d65ae8398594f19ca8e5c3e71e89e982e0df`.
The overlay bundles it as `Contents/MacOS/buzz-mesh-agent`; on macOS host
processes look in the app bundle first, then `~/.local/bin`, then PATH.
Windows/Linux: not bundled yet; put `buzz-mesh-agent` on the app's PATH.

## Triggering

Verified (unit tests only): an explicit `@mention` of the agent by its owner
in a channel or thread. Plain DMs without a mention have not been exercised;
whether Agents delivers them as a mention is unverified. Test with explicit
owner mentions, non-sensitive prompts, and a single fixed community.

## Known limitation: community switch is NOT isolated

The lease is re-checked before publishing, so a reply produced across a
community switch is dropped. That is stale-result mitigation only: a switch
can restart compute on the same port mid-turn, so the prompt may already have
reached the newly selected community's mesh, and check→publish is not atomic.
Real isolation needs the request bound to its lease natively.
