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

After a successful history response, Rust starts a bounded background audit.
It looks up the saved agent and owner, resolves community identity and relay
key from the same HTTPS origin, and fetches current relay-signed DM metadata
and membership. It derives the execution domain and independent resource label,
checks `IfcSession::call` and `IfcSession::read`, and verifies the history's
signatures and channel. IFC failures are printed to the native log; the original
read result is returned immediately. Existing read authorization, signature
checks and network errors retain their behavior.
The audit covers the raw `/query` response; events later merged or projected by
`session.read()` remain unaudited.

At most two audits run concurrently, with a three-second deadline each. Capacity
exhaustion and timeouts are logged rather than delaying or rejecting history.
Audited reads do not share a scheduler job with another caller's read, so their
agent and triggering event remain attached to the correct request. Browser/dev
broker reads keep working but have no Rust audit in this slice. Thread history
and other adapters are unchanged.

This checks one read. It does not bind an IFC session to Claude's retained model
state, rotate model history, enforce publication, or establish a security boundary.
Policy is observed after the read, so the audit makes no claim about membership
throughout the read. Other inputs remain unknown to IFC. Community identity
currently uses the relay's version-1 `read_state_snapshot.community_id` discovery
field; relays without it produce a diagnostic and still return history.

For acceptance with an agreed isolated native agent and DM, send a non-thread
mention and confirm ordinary history and model-session reuse. A missing membership
or unavailable policy lookup should produce an `IFC history audit failed` message
in the native log while the normal read and prompt continue. Runtime and human
acceptance are deferred; local tests remain stopped at the author's request.
