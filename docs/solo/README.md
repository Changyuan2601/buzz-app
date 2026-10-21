# Solo

Solo is a private channel whose only human member is its owner, talking with
their agents. It is not a separate page, message store or relay-enforced privacy
mode: a Solo chat is a channel, opened in Messages like any other, and signed
channel membership remains access authority.

## Model

- **The `buzz.solo` channel label is the one Solo fact.** It is a NIP-CL label
  on the private channel's relay metadata, so every member and agent, including
  remote agents without the owner's encrypted state, reads the same answer.
  Discovery derives `channelType: "solo"` from it alone. A Solo channel gets
  the chat treatment for everyone: a timeline that loads history on scroll and
  top-level agent replies. It reads, caches and threads like any channel. The creator (the relay-written `P`) also gets the
  owner's treatment: the agent-tagged composer, Share, the Workspace control, Chat
  settings and Chat actions. Both come from the channel, in the shared
  conversation scope (`features/conversation/Conversation.tsx`), so every view
  of a chat (the main reader or a secondary tab) composes under the same rules.
  Other channels are threaded. Conversion to a channel clears the label.
- **The label decides the sidebar.** The viewer's own Solo chats list under Solo;
  every other channel, including a Solo chat someone shared with them, lists under
  Team. The sidebar's All / Solo / Team filter lists Solo workspaces and chats above
  Team's channel sections; it never changes the open conversation. Opening a
  destination reveals its inventory unless the filter is All; an unlisted
  conversation waits for the channel list rather than guess. Solo is always on.
- **Workspaces are the only private state.** The encrypted `groups:me` preference
  record holds Solo workspaces and which chat is filed in which workspace. It never
  decides what is Solo.
- **Drafts are a Messages route.** A new Solo chat is
  `{ kind: "solo-draft", project?, agent? }` on the Messages page; nothing exists
  on the relay until the first send. The retired `buzz.me/me`,
  `buzz.sessions/sessions` and channel `new-session` routes no longer exist.
- **Workspaces** are Solo groups. Repositories, pull requests and issues are a
  separate destination (`buzz.repos`), not a container of chats.

Display names ("Solo", "Team", "chat", "workspace") are presentation; code keys
behavior on the label, so a rename touches copy only.

## Current behavior

- Solo workspaces and workspace filing live in the existing encrypted,
  account/community-scoped `groups:me` preference record. Messages groups remain
  independent. Records from before the label also list a `channels` placement
  array; it is ignored and dropped on the next workspace write.
- **Label only:** a private channel without `buzz.solo` is an ordinary Team
  channel, whatever its `about` text. No code reads the retired
  `Buzz session (buzz.sessions/v1)` marker, and there is no migration,
  membership revocation or transcript copy for channels created before the
  label.
- Workspaces are existing Solo workspaces, and Chats are ordinary private channels. New
  chats use ordinary private channels. The first send creates the chat, moves
  the draft into that chat's ordinary composer draft, applies workspace setup
  (Canvas, workspace filing, default agents), then sends through the same
  admission as any Solo send: missing tagged agents are added, then the message
  is queued. Nothing about the start is saved separately. A retry in the same
  view reuses the requested channel; after an interruption the chat exists with
  the text still in its composer. Setup that fails or is interrupted leaves a
  working chat without that setup; it never holds the message. Draft settings
  remain local until first send and use Solo's defaults namespace.
- New Solo chats are created with the `buzz.solo` label and no `about` text, so
  a relay without NIP-CL labels cannot start one. The label is a routing hint for
  agents: answer as one channel-scoped, top-level conversation. It is not access
  authority. The in-app agent harness reads it from the channel list; remote
  harnesses that only read `about` need to learn the label.
- **Share** opens the same access dialog from Solo and Messages. This flow
  preserves channel ID, history, Canvas, existing members,
  Solo label and workspace filing. It neither promotes a conversation nor
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
- Naming and lifetime belong to [Chat settings](#chat-lifetime),
  not Share. Backend read-only roles,
  dynamic inheritance/revocation and synced grant provenance remain deferred or
  blocked in this checkpoint. Sharing does not expose owner-private detailed agent
  activity or start an agent. Proposal documents remain design history, not
  implemented behavior.
- Solo chats and drafts use the full conversation pane. Right-click,
  Shift+F10 and overflow share one sidebar action list: Share, Convert to channel,
  Move to a Solo workspace, Copy and Chat settings (where eligible). Opening a row
  menu does not select the row.
  A chat can also be dragged with a pointer onto another workspace or **Chats**;
  the drop is the same Move to intent, with the same gate, optimistic placement,
  rollback notice and Retry. Like Messages' empty Starred, a hidden empty
  **Chats** section is not revealed during a drag.
- **Archive chat** (⌃⌘A on Apple platforms, Ctrl+Shift+E elsewhere; rebindable in
  Settings → Shortcuts) opens the Chat actions Archive confirmation for the open
  chat, including from the composer, after the menu's fresh permission read; it does
  nothing where the menu offers no Archive. Success returns to Solo. Archived chats
  are restored from search and Channel Settings, as before.
- The owner can add agents from **Channel members → Add agents** without sending
  a message or starting a run. The chooser uses the same available agents as
  the composer, excludes current members and archived agents, and confirms the
  signed roster before reporting success. Additions grant access to the chat and
  its history; people continue to use Share. Closing stops the dialog's continuation,
  while an already-sent membership request may still complete; reopening reads the
  roster, and retry uses the existing membership receipt.
- Solo chats use the ordinary composer with explicit
  owner-scoped agent tags. Empty new-chat drafts start tagged with the device's default
  agent for this account/community. **Agents → right-click → Make default agent**
  changes that choice; its card shows **Default agent**. An unavailable choice
  falls back to the first managed agent, then the first selectable agent, only
  after agent evidence is complete and the requested archive read has settled.
  An available explicitly chosen default does not wait for fallback evidence.
  Follow-ups keep all exact agents notified by the previous send, just like
  Team threads, including the shared Remember mentioned agents preference.
  The account default never replaces recipients in an existing chat.
  Removing or replacing a tag is respected for that draft. Both Send and Enter
  require a tagged agent; existing signed-send recovery preserves its recipients.
  A blocked Enter submission shows “Tag an agent to send” inline. The workspace control follows the editor tools on the same rail;
  model/effort controls read the explicitly tagged recipients.
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
- Solo rows share Team's working-agent signal, animated indicator and activity
  popover, including owned-agent typing in threads and unread-thread actions.
  Agent activity opens the agent's profile in the conversation's panel workspace;
  exact-message/thread actions use the canonical channel reader. Solo workspaces and
  row menus remain independent of Team's sections.
- A Solo chat uses the Messages conversation page: the same secondary
  conversation/tool/panel tabs, pane geometry and tab persistence as any channel.
  Its main timeline is full width, with no main-pane tabs, so its threads open
  in the side pane. A single working agent's Activity
  indicator opens its profile's Activity tab locally; multiple agents or an
  unavailable profile retain the chooser. Secondary conversations of the owner's
  Solo chat keep the same owner-scoped explicit recipients; nothing waits on the
  encrypted workspace record to send. A guest in a shared Solo chat keeps the chat
  treatment with the ordinary composer. Routes and labels never grant access.

## Organization, settings and recovery

Solo workspaces, assignments and workspace defaults never fall back to Messages defaults.
Workspace folders, optional worktree/base branch and Canvas are instructions saved
in ordinary Canvas Markdown; saving settings does not create a worktree or change
an agent process. Templates are copied into each new chat, not live-linked.
Switching a draft to another workspace reloads its Workspace/Canvas defaults while
retaining its independent name and lifetime. Moving
a saved chat only changes its workspace assignment. Saved conversation
settings retain the existing Canvas revision checks and explicit conflict recovery.

Solo workspaces use one bounded 16 KiB recipe record. Only workspace assignments
occupy it, so unfiled chats cost nothing; a full record refuses the filing and
keeps the chat. **Convert to channel** is a
separate, owner/admin-confirmed action for Solo chats, available from
Share and the existing menus. Its Private/Public choice defaults to Private and
warns that Public exposes the full existing history to the community. It appears
in Messages with the same ID, history, Canvas, membership, labels and lifetime.
Conversion is one signed details edit that clears `buzz.solo` (keeping any other
labels) and applies the chosen visibility; the chat moves to Team for everyone.
It then removes the chat's workspace assignment, if any, and opens the channel in
Messages. Share alone never does this. If unfiling fails, Finish conversion
retries only that step. The existing preference owner preserves other workspaces
and assignments. Deleted/archived chats can still hold an assignment. No
cross-device atomicity, automatic compaction or new storage protocol is claimed.

Share attempts retain in-process intent plus durable per-operation Outbox receipts,
not a persisted composite transaction. Start over forgets settled choices, not
submitted operations, confirmed access or workspace filing.
An interrupted link can be retried by its exact ID in Outbox; confirmed delivery
can be removed there before sharing to the same destination again. Unknown
receipts remain protected. Whole-share intent does not survive an app restart.

## Chat lifetime

Lifetime is separate from Share. Before first send, **Chat settings**
offers the existing Ongoing/Temporary duration control for new-chat drafts:
Ongoing means no automatic archive; Temporary defaults to seven days and archives
after the selected duration without activity. Existing custom values are retained.

The validated `ttlSeconds` is sent as the third `channelWrites.create` argument;
there is no create-then-edit. Local settings store name, Canvas and lifetime
together. Invalid stored durations are visible failures, not implicit Ongoing.

The **Chat settings** gear in the header opens the form directly; Solo chat
row menus retain **Chat settings…** alongside their other actions. Both open one
scrollable dialog, with **Chat name** above Workspace/Canvas
(optional for a new draft),
**Lifetime** below it, and one **Save changes** action. The separate Rename editor
and menu action have been removed. There is no separate lifetime menu or tab.
Changed Canvas confirms first, then changed name/lifetime use one fresh signed
channel-details operation. The Solo label, privacy, history, membership and
workspace filing remain unchanged. A no-op closes without writing. If details fail
after Canvas confirms, the dialog keeps the choices
and retry skips that confirmed Canvas revision. Partial confirmation is explained
as an error, not presented as two independent normal save states.

Conflicts require explicit Reload while retaining the selected lifetime; an
unconfirmed save survives modal remount and relabels the single primary action
**Check save status**, without republishing or implicitly saving other draft
changes. Workspace drafts keep their existing revision and conflict recovery.
Workspace defaults are unchanged; a chat without the Solo label has no lifetime control.
Archived, cached, read-only or unauthorized lifetime writes remain excluded or
denied by signed details. Canvas/lifetime capabilities can be independently
unavailable; a failed read never sends an inferred default lifetime.

Closing/retiring a view fences later lifetime admission and late UI completion.
Canvas remains session-owned: navigation does not guarantee cancellation of its
internal preparation or already dispatched write. No atomic rollback or composite
app-restart journal is added. Native GUI, packaged/live-relay and renewed human
acceptance remain separate gates.

Solo settings use the ordinary details command `h,name,about[,ttl][,t…]`. A
chosen name sends the full label set, keeping `buzz.solo` and any other labels.
Unchanged lifetime omits `ttl`; a changed positive canonical decimal
(1–2147483647) sets it, and an empty value removes it. Settings always omit
visibility. Creation permits a positive TTL; empty creation TTL is rejected.
Browser and native signing and publish guards enforce this syntax independently.
The shared fresh-details owner remains edit authority.

## Optional naming

Double-click an editable Solo chat’s sidebar row to rename it inline. The current
name is selected; Enter or clicking away saves, and Escape cancels. Empty or
unchanged names keep the confirmed title. Errors retain the draft below the field;
uncertain saves offer **Check save status** without republishing. This uses the
same signed details owner as Chat settings, retaining lifetime and other labels.

New and saved Solo chats use the same Chat settings form. A blank new name retains
the first-prompt automatic title (80 code points, canonicalized like relay names).
Explicit names use the shared canonical 1–120-code-point validation.

Name/lifetime edits keep the Solo label; only explicit Convert to channel clears
it. Chosen names are recorded using the existing NIP-CL channel label
`buzz.session.named`, added on explicitly named creation or an actual saved name
change. Existing labels are preserved. This requires relay channel-label support;
unsupported chosen-name writes fail before signing. Automatic-name reset remains
deferred. Older chats without this label use a short ID in shared cards until
a name change records the chosen name; the app does not infer provenance from a
prompt or historical title.
Clearing a saved name silently preserves the last confirmed title without a name
write or validation error. Other settings can still save.
The form uses the shared content-sized dialog and its normal footer spacing, with
one body scrollport and no reserved bottom area. The title and actions stay visible
in ordinary short windows. If enlarged controls cannot fit, the outer dialog also
scrolls, retaining space for a complete body control and pointer access to actions.
Name, Workspace folders, Canvas and Lifetime use consistent 32px section spacing;
labels sit 8px above their controls.

Naming uses the existing fresh signed authority/version check and exact full details
readback. Conflicts retain input for explicit Reload; an uncertain name/lifetime save
is checked without republishing or implicitly saving newer Canvas drafts.
Synthetic signed create/rename/readback coverage is not live cross-version-client
acceptance.

Generated sharing messages use `[Session: <chosen name or short ID>](buzz://channel/<id>)`.
Only names carrying `buzz.session.named` replace the ID. Existing signed messages
and recovery receipts keep their original bytes, including legacy `Session ·` labels;
retry matching uses the original chat destination rather than regenerating the
current name. Authorized viewers can see the current chosen name in the card.

Links to Solo chats render as document cards outside the message bubble, before
any caption, with the fixed `Session:` label; the card text still says Session, not Chat.
In the composer, references are staged
above the caption editor with a remove control and saved in the same draft. Sending
serializes the references before the caption as ordinary Markdown links. Selected
mention identities remain bound to caption text; quoted, list, code and hidden
references stay in their original context. Replies, reactions, copy and actions
remain owned by the original message. Navigation and access rules are unchanged.

## Owners and validation limits

`src/bundled/channels/ChannelsPage.tsx` owns every conversation, including the
Solo treatment (`SoloHeading`, `SoloShare`) and drafts; `SoloWorkspaces` and
`features/channel-navigation/SoloInventory.tsx` own the Solo half of
`app/shell/PrimarySidebar.tsx`. Drafting, settings, sharing and conversion live
in `src/features/solo`; Solo workspaces use
`src/features/relay/solo-preferences.ts` and the existing recipe capability.
`src/features/solo/labels.ts` owns the Solo label (`SOLO_LABEL`,
`soloLabels`, `ownSolo`); `src/features/sessions` keeps shared agent sessions. Existing channel,
membership, signing and Outbox owners retain their authority.

Colocated tests cover admission, frozen defaults, navigation lifetime and recovery;
browser fixtures exercise actual app wiring in Chromium and WebKit with synthetic
identities. They do not prove native signing, live persistence/restart,
cross-device/plugin fallback, real-agent effects or opening performance.
Those checks and renewed human acceptance remain delivery gates where applicable.
See [sharing](sharing.md) for the contract.
Human testing, packaged/native GUI, live relay, cross-account, no-wake and hosted
CI acceptance remain separate. Narrow enlarged-text footer clipping/wrapping
remains a presentation limitation; center hit testing and Tab reachability are
not complete visual acceptance.
