# Agents2 "Mesh" type (draft)

Agents2 → New agent → **Mesh**. Its only setting is the prompt. A mention
from the agent's owner runs one inference-only turn: the plugin prepares the
shared-compute target natively (`mesh_compute_prepare_inference`), spawns the
GDK `buzz-agent` helper as host process `buzz-mesh-agent`, speaks ACP over
stdio with no MCP servers, and publishes the reply through Agents2
(`agent.publish`). No tools, no provider fallback.

## Helper setup (draft; not bundled)

The helper is a separate pin from the app's bundled `buzz-agent` CLI/ACP. It is
the goose-core `buzz-agent` (`block/buzz` branch `micn/buzz-agent-goose-core`,
`6a7c51a5a`) plus one ACP session-id fix (`dfbdbe2af`, 15 lines in
`crates/buzz-agent`). That fix is not yet on a remote branch: the block/buzz
pre-push hook rejects it for branch skew against main and two pre-existing
`buzz-acp` test failures. It does not cherry-pick onto main (main's
`buzz-agent` is a different implementation). Until it is published, apply
the patch shared in the collaboration thread:

```sh
git -C buzz checkout 6a7c51a5a          # micn/buzz-agent-goose-core
git -C buzz am ACP_SESSION_ID_FIX.patch # -> fix(buzz-agent): ACP session id
cargo build --release -p buzz-agent
```

Install it where the desktop app resolves host process `buzz-mesh-agent`:

- macOS: `~/.local/bin/buzz-mesh-agent` (searched before the app's PATH).
- Windows: `buzz-mesh-agent.exe` in a directory on the PATH the app is
  launched with (no extra search directories on Windows; `.exe` is resolved by
  the OS). Restart the app after changing PATH. Unverified on Windows so far.
- Linux: anywhere on the app's PATH. Unverified.

Desktop must be built with `--features mesh`.

## Triggering

Verified (unit tests only): an explicit `@mention` of the agent by its owner
in a channel or thread. Plain DMs without a mention have not been exercised;
whether Agents2 delivers them as a mention is unverified. Test with explicit
owner mentions, non-sensitive prompts, and a single fixed community.

## Known limitation: community switch is NOT isolated

The lease is re-checked before publishing, so a reply produced across a
community switch is dropped. That is stale-result mitigation only: a switch
can restart compute on the same port mid-turn, so the prompt may already have
reached the newly selected community's mesh, and check→publish is not atomic.
Real isolation needs the request bound to its lease natively.
