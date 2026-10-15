# Mesh agent native runtime

Plugin-owned runtime linked against Goose
`69de89c50cc01d4e0187d6645bf3618729873f74`.

The Mesh desktop Agent path now calls this plugin-owned Rust loop, not ACP or a
Goose helper. GDK agent, provider and context-management crates are linked directly;
rmcp supplies data types, not a transport. The full Goose crate cannot resolve
its SQLx SQLite dependency alongside this Buzz workspace's rusqlite version.
Developer/Skills implementations are locally extracted for the trial; see
`src/developer/PROVENANCE.md` and its upstream license. A reusable upstream tools
crate is preferable to maintaining this copy permanently.

## Operations

`goose-agent::StateMachine::step` runs the ordered finish → tools → budget →
compaction → inference operations. Buzz holds the in-memory conversation and
applies append/replace effects. No session loader or database is required.
The operations implement GDK's public `Operation`/`Inference` traits rather than
calling the full Goose agent. The stock `InferenceRunner` retries empty responses
and repairs history; this trial's inference operation preserves its fail-visible
empty-response policy and bounded completion collector. The tool operation keeps
whole-batch duplicate-ID validation and observes each result before proceeding,
including partial results before cancellation. Neither concrete stock operation
is claimed as reused here.

## Ownership

Rust owns inference/tool sequencing. The existing Mesh gateway and selection lease
own the approved endpoint. Native validates the stored agent type/community;
page reload, selection retirement and cancellation fence turns. The shared Buzz
tools call the existing TypeScript handlers through correlated Tauri callbacks,
then the existing captured AgentHandle/native signer. No keys enter the model or
callback. This preserves Buzz's trusted-main-WebView model, not a hostile-plugin
sandbox.

Local catalog: shell, load_skill. No tree/image/installer/delegation.
Filesystem skills use explicit workspace and home roots. Local tools have the
user's filesystem authority, not a sandbox. Shell capture is bounded to 256 KiB,
execution to 120 seconds, and Unix process-group/collector drop cleanup stops
background descendants. Tool replies exceeding 32 KiB become a recoverable error;
completed effects are never assumed rolled back or automatically replayed.

Agent mode always includes Buzz tools. Chat is unchanged and has
no local tools. The full shared Buzz catalog is exposed with `buzz_` names: send,
message edit, reactions, read, channels, members, users, DM, memory get/set,
canvas and media reads. Final prose is still automatically posted independently of tool
sends. Each turn receives Buzz conversation history; exact older messages can be
read with the Buzz read tool. Follow-ups queue, not steer.

Compaction calls upstream goose-context-management between completed tool rounds
above 24 KiB serialized conversation, accepting a generated summary under 12 KiB.
The latest user request is retained verbatim alongside the summary. Before summary
work, admission and round guards remain enforced; completed tool-result payloads
crossing 256 KiB are replaced oldest-first with explicit omission markers. Original
results remain in the observer trace. Markers survive subsequent compaction.
Provider context overflow permits at most two inference retries, each with strictly
smaller conversation input, using the same upstream summarizer. This does not
redispatch tools. Summary calls are bounded to 300 KiB (including formatted history
and template); upstream summary retries must strictly shrink their actual input.
A retained large request may keep context above the trigger, so unchanged compacted
input is not summarized repeatedly. This is a
low byte policy, not a token-count or model-window guarantee. The system/catalog
remain separate. Empty/failed/oversized summaries fail visibly. Hard context bound
256 KiB; response payload 64 KiB/4096 chunks; whole turn 240 seconds/24 rounds in
the app. The provider retains its own HTTP retry behavior (a 400 produces four
requests in the fixture); the loop never replays a failed turn.

The existing transcript renderer shows up to 50 in-memory trial runs, including
partial tool results. Reload/quit discards those traces; no Goose session database
or complete cross-turn tool replay is introduced. Streaming is buffered per model
response rather than token-rendered in the UI.

## Historical trial validation scope

Experimental crate: 96 passing tests, including real HTTP SSE provider, local
shell file-change/skill execution, chunk equivalence, large-result bounds,
compaction continuation/failure/cancellation, capability separation and callback
correlation. Native suite: 424 passed, 3 ignored with `--test-threads=1`, including
real leased Gateway → GDK → local filesystem tool → next completion and request
serialization/page-generation tests. Full frontend Vitest: 8,906 passed after obsolete ACP test removal;
TypeScript clean. Independent review and targeted follow-up cleared the previous
inline implementation findings; the subsequent operations conversion and full
Buzz catalog change have local tests, not a fresh independent review.

These are local fixtures, not packaged GUI/live Mesh/real-relay acceptance.
Default-parallel native runs still hit short-deadline host-command failures;
serial success does not resolve them. Native Clippy is blocked by a pre-existing
needless borrow in `sharing.rs:328` (verified in base). Experimental crate Clippy
passes. Those historical trial checks did not change an installed app or existing Mesh node.

## Size evidence

Earlier standalone provider/loop probe added ~8.21 MiB over its Tokio baseline;
that predates extracted tools/native integration and is not the desktop delta.
The final complete app size is recorded with the exported bundle. The archived
old app used a different build shape, so its size is not a controlled comparison.
Cargo target/cache usage is separately disposable, not shipped app size.
