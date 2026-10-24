# Sharing a Solo chat

Sharing uses ordinary channel membership. Solo project filing is private
client-side organization, independent of access; see [Solo](README.md).

## Current sharing behavior

The Solo chat header's **Access** button and the conversation-row **Share…** action
open the one access dialog every conversation uses
(`ChannelMembersDialog`). In a Solo chat it is titled **Chat access**, with the chat name as its description. Share stays in the
same conversation: no metadata change, promotion to a channel, Solo removal or automatic
navigation to Messages. Name, visibility and lifetime are not recipient-sharing
controls. **Convert to channel** lives only in the chat's actions menu; empty-selection
**Done** never converts. **Copy link** sits at the footer's leading edge and copies
`buzz://channel/<id>` only; its pointer/keyboard hint explains that copying grants no
access. Recipients still need independent membership. Each row with access has the
same actions menu as channel members, so the chat owner can remove someone.

The dialog is the channel Members dialog with Solo rules. One search field (accessible
name **Search people and channels**, or **Search people, agents and channels**
for an owner who can add agents; no visible label) filters current access and
lists people under **Not in this chat**, each with an **Add** button; Enter adds the
highlighted person. Adding is immediate and uses the Solo share rule
(`canShareSoloChat`), with the same per-person **Adding…**, error and **Retry**
states as channel invitations. The owner's selectable agents (the composer's
available agents, without archived ones) are offered too and join directly through
the membership API without starting a run. Other known agents are excluded using
`session.agentChoices` and profile evidence; where the viewer cannot add agents, a
note says to mention an agent in the chat instead. Unknown classification is not proof of humanity. Teams
are not offered. Eligible existing stream/forum channels appear in a separate
**Channels** group; **Select** chooses one channel to share to. A status line
under the field says people with access can read the full history. Current access
uses the channel groups (**People**, **Agents**) with Owner and Admin tags,
hiding empty groups. Confirmed channel shares recorded on this device appear under
**Shared with channels** as one **#channel** disclosure with an **N members**
subline per destination; expand to inspect its recorded recipients who still have
verified chat access. The verified roster still shows loading or failure, with the
header refresh, never treating a failed read as an empty audience.
Named identities have no routine public-key subtitle in search or selected/current
rows. The shared naming policy receives current members and
transient search facts. If resolved names still collide (including when the naming
plugin is disabled), only those names receive a `publicKeyLabels` qualifier. The
unnamed-key fallback remains; keys still own
selection and writes. The sidebar's Shared mark describes current human access, not
share history.

People gain access to the full existing history and new messages. Selecting a
channel shows **#name** with its **N members** subline, including the viewer,
in a default-closed disclosure. Expand it to inspect participants; Remove is a
separate sibling action. One strong roster read on selection supplies display
evidence, with loading/unavailable states and Retry participants instead of zero.
Profiles load on expansion. This display read is separate from the fresh frozen
audience used on submission. Once captured, the selected-channel disclosure shows
the original channel snapshot, labelled **Submitted audience**, including on
reopen. Its rows/count never switch to current destination membership during Retry;
new arrivals are not added and departed members remain in the submitted audience.
Start over is required to choose a new audience. Confirmed grants record the original channel snapshot separately as
device-local display history, not proof of link delivery. The grant remains a
snapshot: future joins/departures are not synchronized. **Share** grants one fresh relay-confirmed destination roster,
including bots but excluding known-archived identities, then posts one ordinary kind-9 link without notification tags.
Its hover/focus hint explains that channel sharing grants access and posts a link.
The footer reuses shared Dialog wrapping: each whole action gets its own flex item,
so Copy link and Share can occupy separate rows at narrow widths or enlarged text.
Only a single action wider than the available row uses the shared horizontal
scrolling fallback. There is no nested action scrollport or feature focus-scroll handler.
Adding a person grants access without posting or sending a DM. These
recipients use ordinary membership-based discovery; immediate recipient visibility
has not been validated across accounts. **Copy link** provides an explicit manual
handoff. A channel link opens the same chat ID/history, not a copied chat or
a new thread. Reopen Share to post that same chat in another channel, one
channel per submission. With no channel selected, **Done**
closes without writes. An empty channel audience cannot post a zero-recipient share.

The sidebar's Shared mark is status only, not an action. It uses a non-cached verified current roster and positively
cached non-agent profile/agent-choice evidence for an additional human, including
another human owner. Known bot roles may exclude a member, but administration
readiness is not required: cold rendering does not refresh roles or profiles.
Unknown profiles remain unclassified; absence of the indicator is **not** a privacy
promise. The access dialog loads roles and profiles on demand, without per-row reads,
polling. Its device-local share history is display-only and does not drive the
indicator. Clicking the indicator opens that same dialog.

## Sending a copied chat link

Pasting a recognized Solo chat link into a stream/forum composer stages its
existing chat card. Sending that card (at channel level or in a thread) asks
**Share and send** or **Send link only**. Closing preserves the draft. Share uses
the existing fresh destination roster and membership grant helpers, including
channel agents, before the composer queues its original message. It does not
post a second card or retarget a thread reply. Link-only leaves access unchanged.
The fresh roster is captured before asking, so the dialog names the channel and
how many captured members don't yet have access, and Share grants only them.
When every captured member already has access to the chat, including when no one
else is in the channel, the message sends without asking. If Share can't succeed
(the viewer can't share the chat, or more than 100 members need access), the
dialog explains why and offers only link-only.

Consent covers the full chat history and future messages, not just a preview.
Grants are opportunistic: everyone is tried, and when at least one succeeds the
message sends and a toast names who couldn't get access. When none succeeds the
message stays unsent and the dialog keeps Retry; that retry preserves its captured
audience and existing operation receipts. Losing the right to add anyone stops the
remaining grants instead of trying each person.
Several new people go in one kind 9000 with a `p` tag each (agents carry `bot`
as the tag's role), humans first. A relay without batch support adds only the
first, so the chat's roster decides who was added; everyone it missed gets the
single addition, which also reports their own failure. See the relay's
kind 9000 entry in block/buzz `NOSTR.md`.
Partial grants remain real access even if the user cancels or sends only the link.
A changed draft stops before the next grant is dispatched. Leaving the composer
cancels further grants and sending, not already dispatched writes. Outbox remains their recovery owner. A separate in-progress Share for the
same chat must finish first. Channel audiences skip known-archived members, including
ones archived before their grant starts on retry. Other grant failures remain
visible; direct-person choices still reject archived identities. Sharing never
unarchives anyone or removes them from the source channel.

This first slice covers staged cards in channels and their threads, not ordinary
message links, DMs, Solo destinations, editing an already-sent message, or new-chat
creation. No implicit invitation, sidebar redesign, source-origin change, or new
relay protocol is added. Cross-account/live and rendered interaction checks remain
separate from the signed fixture tests.

## Retry and operation ownership

`src/bundled/channels/ChannelMembersDialog.tsx` owns presentation using shared Dialog,
SearchField, Accordion, Avatar, Button, IconButton and Tooltip; `useSoloShare.ts` owns
the Solo sharing state. `share-attempt.ts` retains exact
submitted intent in process per RelaySession/source ID; `share.ts` owns fresh
destination evidence, grants and link receipts. Membership authority and durable
operation IDs remain with member additions and Outbox. This sharing flow adds no
host or relay capability.

The channel audience is deduplicated and bounded to 100 distinct keys before any
grant. The fresh snapshot freezes before grants and is retained on retry, including
over-capacity evidence. An oversized snapshot sends no grants; Retry keeps that
snapshot even after destination membership changes. **Start over** is required to
capture a different audience. Confirmed grants are skipped. Saved grant IDs, link IDs, unknown delivery, concurrent
remount guards, stale Retry/Start over guards and chat lifetime fencing remain.
Grants here are opportunistic too: if anyone was granted, the link posts, the
share finishes and a toast names who couldn't get access; reopen Share to try them
again. If nobody was granted, the error and Retry stay in the dialog.
Partial failures distinguish confirmed access from unconfirmed link posting. Pending
buttons retain their label and block duplicate activation. The first pending share
keeps its existing footer actions: saving an in-flight receipt does not insert a
disabled **Start over** button. Recovery offers Start over after failure and keeps
that button in place, disabled, while Retry runs. Changed eligibility
shows inline access-change recovery and disables Share/Retry until access recovers. Closing a view does not
cancel submitted work; a superseded visit receives no completion navigation.

Share attempts target an existing channel, with the same exact link on retry. Share cannot create channels or change their
settings. This is not an atomic grant/post transaction or a persistent composite
app-restart journal. Start over clears choices, not access or
queued operations; a deliberately new attempt may post another link.

## Explicit conversion, separate from Share

The product owner approved this distinction on 2026-10-14: **Share** keeps the
Solo label and project filing; **Convert to channel** removes the Solo label and
the initiating viewer's project filing, so the same conversation becomes an
ordinary Team channel, either Private or Public. It changes organization and
conversation behavior for every member, never creates a new conversation or
copies history.

The Solo chat header overflow and the Solo row menu offer **Convert to channel**
for the viewer's own Solo chat.
`src/features/solo/ConvertToChannel.tsx` reuses the shared Dialog, Field,
Private/Public RadioGroup and Button. Private is the default; Public warns that the
community can view the full existing history. A selected share channel is never
granted by conversion. Conversion is disabled while a share is pending; recover or
Start over that share first. Cancel writes nothing and returns focus to the
retained initiating control.

The sequence is explicit, not atomic:

1. Confirm one signed kind-9002 command through the existing `channelDetails`
   owner. Fresh metadata, owner/admin authority, conflict checks,
   altered-signature rejection and exact readback remain unchanged. The edit
   removes `buzz.solo` from the channel's labels and applies the chosen
   visibility; name, lifetime and other labels are preserved.
2. Refresh Solo projects and, if this viewer filed the chat in one, clear only
   that assignment through `soloPreferences.assign(id, undefined)`. Its encrypted
   account/community record, serialization and Outbox own persistence. Other
   projects, conversations, defaults, memberships and other people's filing are
   untouched.
3. Announce **Converted to channel.** and open the same channel ID in Team. No
   new grant, notification, agent wake or transcript write occurs.

The form lives outside the disappearing Solo row. Replacement-composer autofocus
does not steal its focus. Actual navigation, connection replacement and unmount
fence subsequent steps and late completion; already-enqueued writes still belong to
their existing durable owners. No completion navigation is sent to a superseded
visit.

### Partial success and recovery

An uncertain metadata publication offers **Check status**, never automatic resend.
The pending details owner retains exact selected visibility; **Reload chat
details** recovers failed reads without losing that intent. If another details
surface confirmed the publication, fresh matching metadata can advance the retained
conversion receipt without another kind-9002 command.

`conversion.ts` retains only chat-local orchestration intent and the confirmed
metadata phase, with a shared running guard. It is not permission evidence or a
persistent transaction. After the label edit succeeds but project unfiling fails,
the dialog says **Channel converted. Finish removing it from its Solo project.**
**Finish conversion** re-reads details, confirms the label is gone and the
settings are unchanged, and retries only the preference write. Restart loses the
orchestration receipt, not access or the channel: the conversation is already an
ordinary Team channel, and a leftover project assignment for a channel without the
label is ignored by Solo.

### Ordinary behavior after conversion

Without the label, every member and agent reads the conversation as an ordinary
channel. Subsequent Claude/Codex/native-runner turns use ordinary channel
reply/typing policy. Already admitted turns retain their frozen policy;
conversion does not cancel running work. No runtime rewrite or new agent authority
is added. Old Solo routes use type-correct composer flags and ordinary recipient
controls for an ordinary channel.

The same ID, history, Canvas, members, other labels and lifetime remain. Public
uses the existing `visibility=open` wire tag and does not introduce an enforceable
View-only role.

## Explicitly deferred or blocked

- **Create new channel** was removed from the Share dialog for this slice.
- Optional creation names, saved renames and standalone lifetime use the unified
  [Chat settings](README.md#optional-naming) form, not Share. Persisted naming
  provenance, automatic-name reset and dynamic link titles remain deferred.
  Old and new generated links keep their numeric labels after a rename.
- **Can view / Can participate** is deferred to a second PR. Read-only requires
  relay-enforced authorization and a matching client capability contract; a
  cosmetic role switch or disabled composer is not sufficient. This slice shows
  neither a fake dropdown nor a static role tag.
- Direct-person DM/link delivery is not implemented. Access grants alone are not
  a dedicated invitation or share notification; explicit automatic handoff needs
  a separate product decision.
- Dynamic destination inheritance/revocation, synced grant provenance and removal
  permissions remain unimplemented. The approved device-local display history is
  not an authorization record or a composite restart journal. Standalone
  creation/lifetime editing belongs to Chat settings, not a dependency of
  sharing or conversion and not a Share option.
  No provenance is inferred from links or membership.

## Device-local display history

`share-history.ts` reuses scoped view storage under
`sessions:shares:<source-id>`. It is plaintext browser/WebView local storage,
partitioned by account, community and source chat, not encrypted host or relay
data. Records are bounded to 64 KiB per source, 100 channel segments and 1,000 keys
per segment/direct list. Malformed, oversized or unreadable history fails visibly
without replacing the prior record. There is no eviction or automatic repair:
a full/malformed record remains blocked for that chat on this device until its
local view state is cleared (leaving the community purges it with other view
state). Later shares can still grant access and post their link. Current access
still appears in its role groups.

The attempt captures the original channel roster separately from its combined
retry audience. Only confirmed grants merge into history, including partial
successes. Repeated shares to the same destination coalesce. Completed grant/link operations
retire if history saving fails; the warning stays visible and Done never replays
those operations.

Recorded channel recipients/counts intersect the confirmed original-share union
with verified current source-chat access, including the viewer when present.
Current destination names may update labels, but later joins/departures do not
change history or synchronize access. Current access is always listed by role,
independent of history. Failed source evidence
shows loading/retry, not an access claim. Historical or other-device provenance is
never inferred from roster overlap, links or display names.

## Required PR-description limitation note

> Sharing segments are display-only history saved on this device, partitioned by
> account and community. They survive reload/restart on this device but do not sync
> across devices and are not backfilled for earlier shares. Current access is
> listed as People and Agents, not by share provenance. Channel
> groups retain confirmed original-share keys filtered by current chat access; they do not auto-sync destination
> membership or prove link delivery. History-saving failure never revokes access or
> replays completed grants/messages. Cross-window writes have no merge-transaction
> guarantee, and this adds no composite operation restart journal. Synced encrypted
> history is deferred.

## Validation and remaining acceptance

Mounted component/service tests cover exact signed grants, frozen retry intent,
conversion recovery and draft-settings failure/retry. Existing Chromium/WebKit
journeys exercise actual app wiring, storage reload, focus, portal containment,
scrolling and footer reachability.

Human confirmation of the rebased build, packaged/native GUI quit/relaunch,
live relay ACLs, cross-account discovery, no-wake behavior, hosted CI and required
reviewer approval remain separate gates. The 2026-10-14 integration checkpoint
in the evidence document records the rebase and focused checks, not shipping
acceptance.
Main's opaque modal fill supersedes the earlier translucent dialog screenshots;
anchored floating surfaces retain their shared treatment.
The configured desktop/Vite remain running. PR preparation performs no live share,
settings write or app restart.
