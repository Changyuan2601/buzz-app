# Shared chats

A shared chat is a chat with an agent, shared into a channel so people and
agents can find and read it. Solo chats themselves are documented in
[Solo](../solo/README.md). The wire topic `buzz.shared-session.v1` and the
agents' `shared_sessions` tool keep their names: both are contracts.

## Channel Shared chats

Stream and forum headers expose Shared chats in the existing channel tab host.
The list shows each readable chat's current source title (or short ID), latest
sharer, share date and short ID. It does not read transcripts to render titles,
require summaries, or start inference. The UI search matches loaded titles and
the current display names of every contributing sharer, including earlier sharers.
It searches neither chat contents nor participants who did not share. A cursor
means older messages remain. Inaccessible entries and their counts stay hidden.
Unknown reads show a generic retry state.

New Share-to-channel messages and composer chat attachments carry the
`buzz.shared-session.v1` topic and explicit source references. The confirmed
signed message is the durable association; there is no device-local catalog write.
Historical unmarked messages with visible Session- or Chat-labelled cards also contribute,
using at most their first 32 distinct original signed references, intersected with
current edited content. Oversized messages cannot block paging to older shares.
Bare links, generic links, quoted/code/hidden cards and edited-in new sources do
not establish associations. Copied labelled cards are indistinguishable
from historical shares and are included. No history or permissions are rewritten.
An old card does not prove its access grants completed; source access and the
agent's answer audience require independent verification.
Current canonical edits/deletions determine surviving contributions;
duplicates collapse by source ID. Removing the final contribution removes the
entry without revoking access to the source chat. Membership grants remain
roster-at-share, without automatic synchronization.

The catalog pages ordinary channel messages because the inspected relay applies
topic filtering after its SQL limit. Each request scans up to 1,000 messages in
50-message reads, stopping between messages at the candidate target. Results
include continuation and scan coverage; an incomplete scan never establishes
absence. Metadata and roster reads use one writer-backed combined query,
bounded to the relay's 1,000-record event-query limit. Original source metadata and
transcripts are used, including for readable archived chats. Sources must match
the canonical private-stream chat metadata contract. Catalog reads use fresh,
verified remote events without local Outbox or live projections, preserving remote
page size even when an acknowledgement was lost. Background refreshes serialize
with explicit paging, preserve loaded depth, and give one queued user action
priority over trailing refresh work.

Codex, Claude Code and Goose expose the shared `shared_sessions` list/read tool.
The host binds the answer destination. After reading metadata, associations and
content, the agent performs one final versioned audience-authority query against
current server channel/membership rows. The response must match the NIP-11
community binding, authenticated agent, destination and complete ordered source
set. Ordinary event arrays, unknown capabilities and incomplete responses cannot
authorize output. Results are released synchronously after that decision, without
further awaited reads. Signed discovery records can conservatively withhold data,
but cannot independently authorize it. Private sources are withheld for public
destinations, whose readers can exceed the roster. Optional contributing share IDs
from list are exact-event lookup hints for read, still subject to association,
destination, edit/delete and access verification. Standalone MCP without trusted
relay authority cannot retrieve protected chats. **Deployment dependency:** the
relay must advertise and implement audience-authority v1 before channel-agent
retrieval works; unsupported communities receive a capability error when protected
candidates require authorization. The human catalog does not depend on that new
capability.
Agents cite source links and must not interpret a title miss as proof no relevant
work exists. Already consumed model context cannot be retroactively erased.

The browser journey in `tests/browser/shared-chats.spec.mjs` exercises Share,
its confirmed receipt, View routing, the title list, search and source opening
against the signed synthetic relay. This does not establish deployed relay paging,
cross-device persistence, or a live model's discovery/retrieval behavior.
