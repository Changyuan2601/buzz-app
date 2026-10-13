# Information-flow control

The policy library is ported from `block/buzz` at
`c94c7128dd6c5cf12486cad0ed767b4ac21ca56a` (PR #8226).

- `ifc-core` supplies reader-set labels, their flow ordering, and accumulated
  flow state. It has no Buzz dependencies.
- `buzz-ifc` derives execution domains from verified Buzz facts and labels
  resources from their own conversation. Domains compare structurally; event
  IDs, topics, and membership ordering do not affect equality.
- `IfcSession` preserves a domain's flow state and checks reads, non-publishing
  calls, and publications. `AuthorizedPublication` owns the exact checked bytes.

These APIs perform no I/O. A broker must verify signatures, establish the
community and current membership, and retain the IFC session for as long as the
corresponding agent state survives. Domain equality is not a temporal epoch.
Unknown inputs remain recorded and block publication.

The port retains the source policy, public APIs, doctests, and regression tests.
Its only adaptations are local Cargo dependencies, the app's Nostr version,
and a local UUID-backed `CommunityId`, avoiding the relay's `buzz-core` crate.
The [design paper](practical-information-flow-for-buzz-agents.md) describes the
model and its assumptions. Adding these crates alone does not mediate Agents.

## Observational history read

Claude Code Agents continues to use the existing `session.read()` for recent
DM history. The shared `IfcContext` carries the agent and signed triggering event
through the existing scheduler, transport and `relay_http` command. There is no
opt-in flag, alternate history command, or change to the history result.

For native non-thread DMs, the harness selects the Claude history ID before
spawn/initialization, including warmed spares and saved resumes. The immutable
host selection is separate from the mutable reported `sessionId`; a reported
mismatch permanently leaves that process unknown, even if it later reports the
selected ID again. Existing binding facts keep their original ID and are never
relabelled to a reported replacement. Preparation rechecks identity before
delivering the prompt. Its existing recent-history read carries that ID,
the saved binding (if any), and whether the history is new. After the ordinary
authorized `/query` succeeds, Rust resolves the saved agent and owner, community
identity and relay key from the same HTTPS origin, and current relay-signed DM
metadata and membership. It derives the execution domain and independent resource
label, checks `IfcSession::call/read`, and verifies history signatures and channel.

Rust returns the unchanged HTTP response immediately and sends versioned
verified facts through a separate native IPC Channel receipt.
The trusted app stores those facts in the existing saved Claude session record,
under its actual ID, before sending the first prompt. The first binding remains
stable across idle process eviction, reconfiguration, saved resume and app restart.
Later turns reconstruct that original structural `ExecutionDomain` and compare it
with the current verified domain. Incompatible reuse is logged; read checks use
the original domain rather than relabeling retained history. A failed resume's
replacement gets a new ID and a new binding. Stale process results and concurrent
first turns cannot replace a newer or already installed binding.

Old histories without valid metadata remain unknown. A failed lookup or failed
binding persistence also leaves history unknown; a later turn cannot retroactively
bind it as new. Each reconstructed `IfcSession` marks unmediated inputs unknown,
so this association does not attest clean provenance. The audit covers the raw
`/query` response; events later merged or projected by `session.read()` remain
unaudited, as do other model inputs and tools.

Policy work admits at most two simultaneous lookups, without a queue, and has a
three-second deadline. The ordinary read releases its scheduler slot without
waiting for policy. Only the eligible turn waits separately for the receipt
before prompt delivery. Errors, timeouts, capacity exhaustion and incompatible
reuse are diagnostic: they never deny the ordinary authorized read, replace its
history with an empty batch, rotate history, or prevent model delivery. Late
receipts after that three-second wait, read failure or generation change cannot
retrospectively bind delivered history. The ordinary foreground read keeps its
original deadline and cancellation behavior. Existing read authorization, network
failures and model-session reuse retain their behavior.
Audited reads do not share a scheduler job with another caller. Browser/dev broker
reads have no native binding, and thread history and other adapters are unchanged.

This is a log-only retained-domain association, not isolation, publication or
managed-memory enforcement, and not remote-agent support. Domain equality is
structural, not an epoch: leaving and rejoining the same membership set can yield
the same domain. Policy is fetched after the read, so membership throughout the
read is not attested. Community discovery requires the relay's version-1
`read_state_snapshot.community_id`; unavailable facts produce a diagnostic.

Runtime and human acceptance are deferred. Focused session-lifecycle, native
transport, runtime wiring and signed-policy regression coverage is added, but
tests remain unexecuted at the author's request.
