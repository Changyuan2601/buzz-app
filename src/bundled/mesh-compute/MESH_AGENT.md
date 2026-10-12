# Agents2 "Mesh" type (draft)

Agents2 → New agent → **Mesh**. Its only setting is the prompt. A mention
from the agent's owner runs one inference-only turn: the plugin prepares the
shared-compute target natively (`mesh_compute_prepare_inference`), spawns the
GDK `buzz-agent` helper as host process `buzz-mesh-agent`, speaks ACP over
stdio with no MCP servers, and publishes the reply through Agents2
(`agent.publish`). No tools, no provider fallback.

## Helper setup (draft; not bundled)

The helper is a separate pin from the app's bundled `buzz-agent` CLI/ACP.
Build it from `block/buzz` at the GDK lineage and put it on the app's PATH
(`~/.local/bin` is searched first):

```sh
git -C buzz-gdk checkout dfbdbe2af   # fix(buzz-agent): ACP session id
cargo build --release -p buzz-agent
cp target/release/buzz-agent ~/.local/bin/buzz-mesh-agent
```

Desktop must be built with `--features mesh`.

## Known limitation: community switch is NOT isolated

The lease is re-checked before publishing, so a reply produced across a
community switch is dropped. That is stale-result mitigation only: a switch
can restart compute on the same port mid-turn, so the prompt may already have
reached the newly selected community's mesh, and check→publish is not atomic.
Real isolation needs the request bound to its lease natively.
