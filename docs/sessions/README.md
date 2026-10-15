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
  draft, channel ID, Canvas and group defaults in the existing pending-start
  receipt. Setup and Me placement must succeed before sending; retries reuse that
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
- Lifetime/settings improvements are separate work. Backend read-only roles,
  dynamic inheritance/revocation and synced grant provenance remain deferred or
  blocked in this checkpoint. Sharing does not expose owner-private detailed agent
  activity or start an agent. Proposal documents remain design history, not
  implemented behavior.
- Me chats and drafts use the full conversation pane. Right-click,
  Shift+F10 and overflow share one sidebar action list: Share, Convert to channel, Rename, Move to a Me
  project, Copy and Chat settings (where eligible). Opening a row menu does not select the row.
  A chat can also be dragged with a pointer onto another project or **Chats**;
  the drop is the same Move to intent, with the same gate, optimistic placement,
  rollback notice and Retry. Like Messages' empty Starred, a hidden empty
  **Chats** section is not revealed during a drag.
- Me uses the ordinary composer with a visible selected assistant plus explicit
  owner-scoped mentions. The selected assistant is device-local view intent keyed
  by account, community and chat; it is not Canvas, group data or channel metadata.
  A plain send targets that assistant, while explicit authored mentions override
  it. Clearing the selection allows an unaddressed message. Me does not apply the
  global automatic remembered-mention prefill; Messages retains that behavior.
  The empty picker says “Choose follow-up assistant” so a one-off mention is not
  mistaken for persistent routing; trials should select the picker before testing
  an unmentioned follow-up.
  The selected assistant is revalidated before every send, and a failure keeps the
  draft. Model and effort controls appear only when the selected or mentioned
  agent exposes those existing capabilities. Saved placement must load before the
  Me reader enables sending; an unavailable preference read is not evidence of
  Messages.
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
an agent process. Templates are copied into each new chat, not live-linked. Moving
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
