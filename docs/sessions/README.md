# Me and sessions

Me is personal organization over ordinary channels, not a separate message store
or relay-enforced privacy mode. Signed channel membership remains access authority.
The earlier [channel-space proposal](spaces.md) is superseded design history.

## Current behavior

- Me placement and groups live in the existing encrypted, account/community-scoped
  `groups:me` preference record. Messages groups remain independent. Placement is
  explicit, not inferred from participant count or local agent availability.
- **Upgrade behavior:** Me starts empty. Existing sessions, including historical
  parent-linked sessions, remain standalone Messages rows. There is no automatic
  migration, membership revocation, nested creation or transcript copy.
- Projects are existing Me groups, and Chats are ordinary private channels. New
  chats use ordinary private channels. The first send freezes the
  draft, channel ID, name, lifetime, Canvas and group defaults in the existing
  pending-start receipt. Setup and Me placement must succeed before sending; retries reuse that
  ID. Draft settings remain local until first send and use Me's defaults namespace.
- New Me conversations add a `personal` line to the session description
  (`Buzz session (buzz.sessions/v1)`, then optional `parent:<uuid>`, then optional
  `personal`). It is a routing hint for agents that cannot read the owner's
  encrypted placement: answer as one channel-scoped, top-level conversation. It is
  not access authority, and explicit Convert to channel clears it with the rest of the session marker.
  Conversations created before the hint are not backfilled.
- **Share** opens the same access dialog from Me and Messages. This flow
  preserves channel ID, history, Canvas, existing members,
  session marker, Me placement and groups. It neither promotes a conversation nor
  navigates to Messages. Empty-selection Done makes no writes; Share’s separate
  bottom-left Convert to channel action opens the explicit visibility confirmation.
  Name and lifetime are not sharing controls.
- Choose people and at most one existing channel. People-only Share grants access
  without a DM or link delivery;
  selecting a channel grants its current roster plus selected people and posts a
  link without notifications. Recorded channel shares show **#channel** and
  **N members** in default-closed disclosures. Recorded direct shares appear
  individually, as do known session agents not shown in a channel group. Unrecorded
  human/unclassified access is collapsed under **Other access**, without a provenance
  paragraph or Session participants heading. Display history is account/community-scoped on this device,
  survives reload, and does not sync across devices or control access. Direct draft
  selections remain visible. Future joins/departures are not synchronized. Copy
  link grants no access; Done with no audience closes without writes. Shared uses
  verified membership and cached human evidence, not privacy inference or a required
  role refresh. See [sharing](sharing.md) for retries and evidence limits.
- Naming and lifetime belong to [Session settings](#standalone-session-lifetime),
  not Share. Backend read-only roles,
  dynamic inheritance/revocation and synced grant provenance remain deferred or
  blocked in this checkpoint. Sharing does not expose owner-private detailed agent
  activity or start an agent. Proposal documents remain design history, not
  implemented behavior.
- Me chats and drafts use the full conversation pane. Right-click,
  Shift+F10 and overflow share one sidebar action list: Share, Convert to channel,
  Move to a Me project, Copy and Session settings (where eligible). Opening a row
  menu does not select the row.
  A chat can also be dragged with a pointer onto another project or **Chats**;
  the drop is the same Move to intent, with the same gate, optimistic placement,
  rollback notice and Retry. Like Messages' empty Starred, a hidden empty
  **Chats** section is not revealed during a drag.
- **Archive chat** (⌃⌘A on Apple platforms, Ctrl+Shift+E elsewhere; rebindable in
  Settings → Shortcuts) opens the Session actions Archive confirmation for the open
  chat, including from the composer, after the menu's fresh permission read; it does
  nothing where the menu offers no Archive. Success returns to Me. Archived chats
  are restored from search and Channel Settings, as before.
- Me (labelled **Solo** in navigation) uses the ordinary composer with explicit
  owner-scoped agent tags. Empty new-chat drafts start tagged with the device's default
  agent for this account/community. **Agents → right-click → Make default agent**
  changes that choice; its card shows **Default agent**. An unavailable choice
  falls back to the first managed agent, then the first selectable agent, only
  after agent evidence is complete and the requested archive read has settled.
  An available explicitly chosen default does not wait for fallback evidence.
  Follow-ups keep all exact agents notified by the previous send, just like
  Multiplayer threads, including the shared Remember mentioned agents preference.
  The account default never replaces recipients in an existing chat.
  Removing or replacing a tag is respected for that draft. Both Send and Enter
  require a tagged agent; existing signed-send recovery preserves its recipients.
  On upgrade, the retired per-chat assistant choice seeds an empty Solo draft
  once, only with that exact eligible agent and remembering enabled. Existing
  prose, attachments, edited drafts and opt-out consume the old choice without
  replacing current intent. Failed draft persistence preserves it for retry.
  It is never a continuing routing fallback. A legacy pending creation keeps
  the exact recipient admitted in its receipt; after delivery, that eligible
  recipient can seed its follow-up without modifying or resending signed bytes.
  A blocked Enter submission shows “Tag an agent to send” inline. The project control follows the editor tools on the same rail;
  model/effort controls read the explicitly tagged recipients.
  Saved placement must load before sending; unavailable evidence is not Messages.
- Claude Code can name a Solo chat from its own generated session title after its
  first successful turn. Only the first tagged agent on the owner’s original
  message can propose the title, even when a retry has different words or tag
  order; the chat must still have its original first-message name. A bounded
  verified read checks up to 100 owner messages through the triggering turn.
  Full, missing, unsent or ambiguous same-second history leaves the title
  unchanged. Human names are never replaced. Codex title generation is intentionally not implemented. This reads
  Claude Code's local history, adds no model request, and uses the owner's ordinary
  channel-details save with revision validation. Live/native title acceptance is
  a separate gate from unit tests.
- Me reuses Messages' sidebar working-agent signal, animated indicator and activity
  popover, including owned-agent typing in threads and unread-thread actions.
  Agent activity opens the agent's profile in Me's per-conversation panel workspace;
  exact-message/thread actions use the canonical channel reader, as other Me links do.
  Me grouping and row menus remain independent of Messages organization.
- Me reuses Messages' secondary conversation/tool/panel tabs and pane geometry,
  with separate per-conversation Me persistence. Its main timeline remains flat.
  A single working agent's Activity indicator opens its profile's Activity tab
  locally; multiple agents or an unavailable profile retain the chooser. Hover previews are
  retained; Down Arrow on a single-agent indicator opens the chooser for keyboard
  access to its conversation actions. Secondary conversations placed in Me keep
  owner-scoped explicit recipients and wait for placement readiness before sending.
- Canonical channel links still use the ordinary channel reader, and Me routes can
  refer to an accessible ordinary channel UUID. Such a channel uses ordinary
  composer and agent reply behavior even if a private Me filing remains. Routes
  and plugin views do not grant access. Disabling the Me view does not delete its channels or memberships.

## Organization, settings and recovery

Me projects, assignments and project defaults never fall back to Messages defaults.
Workspace folders, optional worktree/base branch and Canvas are instructions saved
in ordinary Canvas Markdown; saving settings does not create a worktree or change
an agent process. Templates are copied into each new chat, not live-linked.
Switching a draft to another project reloads its Workspace/Canvas defaults while
retaining its independent name and lifetime. Moving
a saved chat only changes its project assignment. Saved conversation
settings retain the existing Canvas revision checks and explicit conflict recovery.

Me uses one bounded 16 KiB recipe record, not unlimited history storage. Admission
checks its exact serialized size before remote channel creation and again before
saving placement. A full record keeps the draft. **Convert to channel** is a
separate, owner/admin-confirmed action for standalone sessions, available from
Share and the existing menus. Its Private/Public choice defaults to Private and
warns that Public exposes the full existing history to the community. It appears
in Messages with the same ID, history, Canvas, membership, labels and lifetime.
After confirming metadata, conversion removes the initiating viewer's Me placement
and assignment, then opens the channel in Messages. Share alone never does this.
A partial failure offers removal-only Finish conversion; after restart, an ordinary
channel still filed in Me offers explicit Move to Messages without another metadata
edit. The existing preference owner preserves other groups and placements. Conversion
therefore reclaims this placement/assignment's bytes; it does not compact other records.
Admission is not a reservation: another device can fill the record between those
steps. Deleted/archived placements can still consume capacity. No cross-device
atomicity, automatic compaction or new multi-record storage protocol is claimed.

Share attempts retain in-process intent plus durable per-operation Outbox receipts,
not a persisted composite transaction. Start over forgets settled choices, not
submitted operations, confirmed access or Me placement.
An interrupted link can be retried by its exact ID in Outbox; confirmed delivery
can be removed there before sharing to the same destination again. Unknown
receipts remain protected. Whole-share intent does not survive an app restart.

## Standalone session lifetime

Lifetime is separate from Share. Before first send, **Session settings**
offers the existing Ongoing/Temporary duration control for standalone drafts:
Ongoing means no automatic archive; Temporary defaults to seven days and archives
after the selected duration without activity. Existing custom values are retained.
Parent-linked sessions do not offer this control.

The validated `ttlSeconds` is frozen in the local first-attempt receipt before
asynchronous setup begins and sent as the fourth `workSessions.create` argument.
Retries reuse the saved creation event ID: no second creation or create-then-edit.
Local settings now store name, Canvas and lifetime together; old Canvas-only strings
still load. Invalid stored durations are visible failures, not implicit Ongoing.
Setup, Me placement, and first-message ordering retain their existing owners.

The **Session settings** gear in the header opens the form directly; saved-session
row menus retain **Session settings…** alongside their other actions. Both open one
scrollable dialog, with **Session name** above Workspace/Canvas
(optional for a new draft),
**Lifetime** below it, and one **Save changes** action. The separate Rename editor
and menu action have been removed. There is no separate lifetime menu or tab.
Changed Canvas confirms first, then changed name/lifetime use one fresh signed
channel-details operation. The session marker, privacy, history, membership and
Me placement remain unchanged. A no-op closes without writing. If details fail
after Canvas confirms, the dialog keeps the choices
and retry skips that confirmed Canvas revision. Partial confirmation is explained
as an error, not presented as two independent normal save states.

Conflicts require explicit Reload while retaining the selected lifetime; an
unconfirmed save survives modal remount and relabels the single primary action
**Check save status**, without republishing or implicitly saving other draft
changes. Workspace drafts keep their existing revision and conflict recovery.
Section defaults are unchanged; parent-linked sessions have no lifetime section.
Archived, cached, read-only or unauthorized lifetime writes remain excluded or
denied by signed details. Canvas/lifetime capabilities can be independently
unavailable; a failed read never sends an inferred default lifetime.

Closing/retiring a view fences later lifetime admission and late UI completion.
Canvas remains session-owned: navigation does not guarantee cancellation of its
internal preparation or already dispatched write. No atomic rollback or composite
app-restart journal is added. Native GUI, packaged/live-relay and renewed human
acceptance remain separate gates.

The session edit wire command is `h,name[,ttl][,t…]`; trailing `t` tags preserve
existing channel labels and record a chosen name as described below. It never rewrites `about`,
so the legacy session marker and optional parent/personal lines stay unchanged.
Unchanged lifetime omits `ttl`; a changed positive canonical decimal
(1–2147483647) sets it, and an empty value removes it. Lifetime-only changes
omit `about`; session settings always omit visibility. Creation permits positive
TTL only for an ordinary channel or the exact standalone session marker, never a
parent-linked marker; empty creation TTL is rejected. Browser and native signing
and publish guards enforce this syntax independently. The host grammar cannot
prove parent ancestry; the shared fresh-details owner remains edit authority.

## Optional naming

New and saved sessions use the same Session settings form. A blank new name retains
the first-prompt automatic title (80 code points, canonicalized like relay names).
Explicit names use the shared canonical 1–120-code-point validation. The first
attempt freezes the chosen or first-prompt title before any asynchronous setup;
retries do not change it when prompt or local settings change.
Old Canvas-only settings and pending receipts still load without a migration or
another creation/rename operation.

New session `about` metadata uses only the existing marker, optional parent line,
and the `personal` line for Solo chats, exactly as recognized by older Buzz clients.
Custom creation and subsequent renames do not append a `naming:` extension.
Name/lifetime edits leave that metadata unchanged; only explicit Convert to channel
clears `personal`. Chosen names are recorded using the existing NIP-CL channel label
`buzz.session.named`, added on explicitly named creation or an actual saved name
change. Existing labels are preserved. This requires relay channel-label support;
unsupported chosen-name writes fail before signing. Automatic-name reset remains
deferred. Older sessions without this marker use a short ID in shared cards until
a name change records the chosen name; the app does not infer provenance from a
prompt or historical title.
Clearing a saved name silently preserves the last confirmed title without a name
write or validation error. Other settings can still save. Old pending receipts without a frozen name derive it from their original first
prompt, not an edited retry draft.
The form uses the shared content-sized dialog and its normal footer spacing, with
one body scrollport and no reserved bottom area. The title and actions stay visible
in ordinary short windows. If enlarged controls cannot fit, the outer dialog also
scrolls, retaining space for a complete body control and pointer access to actions.
Name, Project folders, Canvas and Lifetime use consistent 32px section spacing;
labels sit 8px above their controls. Parent-linked sessions retain their existing
details-write exclusion.

Naming uses the existing fresh signed authority/version check and exact full details
readback. Conflicts retain input for explicit Reload; an uncertain name/lifetime save
is checked without republishing or implicitly saving newer Canvas drafts. Browser
and native guards consume a shared legacy-metadata contract fixture, accepting only
the existing marker/parent/personal grammar for creation and rejecting extensions.
The parser remains identical to the pre-feature parser. Source compatibility and
synthetic signed create/rename/readback coverage are not live cross-version-client
acceptance.

Generated sharing messages use `[Session: <chosen name or short ID>](buzz://channel/<id>)`.
Only names carrying `buzz.session.named` replace the ID. Existing signed messages
and recovery receipts keep their original bytes, including legacy `Session ·` labels;
retry matching uses the original session destination rather than regenerating the
current name. Authorized viewers can see the current chosen name in the card.

Session references render as document cards outside the message bubble, before
any caption, with the fixed `Session:` label. In the composer, references are staged
above the caption editor with a remove control and saved in the same draft. Sending
serializes the references before the caption as ordinary Markdown links. Selected
mention identities remain bound to caption text; quoted, list, code and hidden
references stay in their original context. Replies, reactions, copy and actions
remain owned by the original message. Navigation and access rules are unchanged.

## Owners and validation limits

`src/bundled/sessions` owns Me navigation and its reused conversation/group UI;
`src/bundled/channels` owns Messages and Outbox recovery. Shared composition,
settings and share intent live in `src/features/sessions`; Me preferences use
`src/features/relay/me-preferences.ts` and the existing recipe capability. Existing
channel, membership, signing and Outbox owners retain their authority.

Colocated tests cover admission, frozen defaults, navigation lifetime and recovery;
browser fixtures exercise actual app wiring in Chromium and WebKit with synthetic
identities. They do not prove native signing, live persistence/restart,
cross-device/plugin fallback, real-agent effects or opening performance.
Those checks and renewed human acceptance remain delivery gates where applicable.
See [sharing](sharing.md) for the contract and
[validation](sharing-evidence.md) for checked snapshots and remaining gates.
Human testing, packaged/native GUI, live relay, cross-account, no-wake and hosted
CI acceptance remain separate. Narrow enlarged-text footer clipping/wrapping
remains a presentation limitation; center hit testing and Tab reachability are
not complete visual acceptance.

## Channel Shared sessions

Stream and forum headers expose Shared sessions in the existing channel tab host.
The list shows each readable session's current source title (or short ID), latest
sharer, share date and short ID. It does not read transcripts to render titles,
require summaries, or start inference. The UI search matches loaded titles and
the current display names of every contributing sharer, including earlier sharers.
It searches neither session contents nor participants who did not share. A cursor
means older messages remain. Inaccessible entries and their counts stay hidden.
Unknown reads show a generic retry state.

New Share-to-channel messages and composer session attachments carry the
`buzz.shared-session.v1` topic and explicit source references. The confirmed
signed message is the durable association; there is no device-local catalog write.
Historical unmarked messages with visible Session-labelled cards also contribute,
using at most their first 32 distinct original signed references, intersected with
current edited content. Oversized messages cannot block paging to older shares.
Bare links, generic links, quoted/code/hidden cards and edited-in new sources do
not establish associations. Copied Session-labelled cards are indistinguishable
from historical shares and are included. No history or permissions are rewritten.
An old card does not prove its access grants completed; source access and the
agent's answer audience require independent verification.
Current canonical edits/deletions determine surviving contributions;
duplicates collapse by source ID. Removing the final contribution removes the
entry without revoking access to the source session. Membership grants remain
roster-at-share, without automatic synchronization.

The catalog pages ordinary channel messages because the inspected relay applies
topic filtering after its SQL limit. Each request scans up to 1,000 messages in
50-message reads, stopping between messages at the candidate target. Results
include continuation and scan coverage; an incomplete scan never establishes
absence. Metadata and roster reads use one writer-backed combined query,
bounded to the relay's 1,000-record event-query limit. Original source metadata and
transcripts are used, including for readable archived sessions. Sources must match
the canonical private-stream session metadata contract. Catalog reads use fresh,
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
relay authority cannot retrieve protected sessions. **Deployment dependency:** the
relay must advertise and implement audience-authority v1 before channel-agent
retrieval works; unsupported communities receive a capability error when protected
candidates require authorization. The human catalog does not depend on that new
capability.
Agents cite source links and must not interpret a title miss as proof no relevant
work exists. Already consumed model context cannot be retroactively erased.

The browser journey in `tests/browser/shared-sessions.spec.mjs` exercises Share,
its confirmed receipt, View routing, the title list, search and source opening
against the signed synthetic relay. This does not establish deployed relay paging,
cross-device persistence, or a live model's discovery/retrieval behavior.
