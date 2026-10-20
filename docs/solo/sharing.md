# Sharing a Solo chat

Sharing uses ordinary channel membership. Solo project filing is private
client-side organization, independent of access; see [Solo](README.md).

## Current sharing behavior

The Solo chat header, conversation-row Share action and Shared indicator open the
same **Share chat** access dialog. Share stays in the
same conversation: no metadata change, promotion to a channel, Solo removal or automatic
navigation to Messages. Name, visibility and lifetime are not recipient-sharing
controls. The separate **Convert to channel** action sits at the footer’s leading
edge and opens a visibility confirmation; empty-selection **Done** never converts.
**Copy link** copies `buzz://channel/<id>` only; its pointer/keyboard hint explains
that copying grants no access. Recipients still need independent membership.

One searchable, grouped picker offers eligible existing stream/forum channels,
then people. Select multiple people and at most one channel; removing the selected
channel makes other channels available again. Known agents are excluded from direct
people search using `session.agentChoices` and profile evidence. Unknown
classification is not proof of humanity. Direct draft selections stay visible under
**People or channel**. Confirmed shares recorded on this device appear as one
**#channel** disclosure with an **N members** subline per destination; expand to
inspect its recorded recipients who still have verified chat access. Recorded
direct shares remain individual even with channel overlap. Other known agents
already in the chat appear individually unless represented in a recorded channel
group. Agent classification does not imply a prior share. Unrecorded human or unclassified access stays inside a
default-closed **Other access** disclosure with a member count and no provenance
paragraph. There is no Session participants or Has access heading, nor a static Can
participate label.
Only draft selections have Remove actions; these remove a selection, never revoke existing access. The verified roster still
shows loading or failure with Retry, never treating a failed read as an empty audience.
Named identities have no routine public-key subtitle in search or selected/current
rows. The shared naming policy receives current members, draft recipients and
transient search facts. If resolved names still collide (including when the naming
plugin is disabled), only those names receive a `publicKeyLabels` qualifier. The
unnamed-key fallback remains; keys still own
selection and writes. The Share action uses a share-arrow icon distinct from the
Shared status icon. The icon describes current human access, not share history.

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
Direct selections stay separate. Start over is required to choose a new audience. Confirmed grants record the original channel snapshot separately as
device-local display history, not proof of link delivery. The grant remains a
snapshot: future joins/departures are not synchronized. **Share** grants the
union of directly selected keys and one fresh relay-confirmed destination roster,
including bots but excluding known-archived identities, then posts one ordinary kind-9 link without notification tags.
Its hover/focus hint explains that channel sharing grants access and posts a link.
The footer reuses shared Dialog wrapping: each whole action gets its own flex item,
so Copy link and Share can occupy separate rows at narrow widths or enlarged text.
Only a single action wider than the available row uses the shared horizontal
scrolling fallback. There is no nested action scrollport or feature focus-scroll handler.
People-only **Share** grants access without posting or sending a DM. These
recipients use ordinary membership-based discovery; immediate recipient visibility
has not been validated across accounts. **Copy link** provides an explicit manual
handoff. A channel link opens the same chat ID/history, not a copied chat or
a new thread. Reopen Share to post that same chat in another channel, one
channel per submission. Direct people selected alongside a channel are granted
source-chat access, not destination-channel membership or a separate DM link. With no audience, **Done**
closes without writes. An empty channel audience cannot post a zero-recipient share.

The Shared indicator uses a non-cached verified current roster and positively
cached non-agent profile/agent-choice evidence for an additional human, including
another human owner. Known bot roles may exclude a member, but administration
readiness is not required: cold rendering does not refresh roles or profiles.
Unknown profiles remain unclassified; absence of the indicator is **not** a privacy
promise. The access dialog loads roles and profiles on demand, without per-row reads,
polling. Its device-local share history is display-only and does not drive the
indicator. Clicking the indicator opens that same dialog.

## Sending a copied chat link

Pasting a recognized Solo chat link into a stream/forum composer stages its
existing session card. Sending that card (at channel level or in a thread) asks
**Share and send** or **Send link only**. Closing preserves the draft. Share uses
the existing fresh destination roster and membership grant helpers, including
channel agents, before the composer queues its original message. It does not
post a second card or retarget a thread reply. Link-only leaves access unchanged.

Consent covers the full chat history and future messages, not just a preview.
An unsuccessful grant leaves the message unsent and keeps Retry in the dialog;
that retry preserves its captured audience and existing operation receipts.
Partial grants remain real access even if the user cancels or sends only the link.
Leaving the composer cancels further grants and sending, not already dispatched
writes. Outbox remains their recovery owner. A separate in-progress Share for the
same chat must finish first. Channel audiences skip known-archived members, including
ones archived before their grant starts on retry. Other grant failures remain
visible; direct-person choices still reject archived identities. Sharing never
unarchives anyone or removes them from the source channel. Existing audience
bounds still apply.

This first slice covers staged cards in channels and their threads, not ordinary
message links, DMs, Solo destinations, editing an already-sent message, or new-chat
creation. No implicit invitation, sidebar redesign, source-origin change, or new
relay protocol is added. Cross-account/live and rendered interaction checks remain
separate from the signed fixture tests.

## Retry and operation ownership

`src/bundled/channels/SoloShare.tsx` owns presentation using shared Dialog,
Combobox, Accordion, Avatar, Button, IconButton and Tooltip. `share-attempt.ts` retains exact
submitted intent in process per RelaySession/source ID; `share.ts` owns fresh
destination evidence, grants and link receipts. Membership authority and durable
operation IDs remain with member additions and Outbox. This sharing flow adds no
host or relay capability.

The combined audience is deduplicated and bounded to 100 distinct keys before any
grant. The fresh snapshot freezes before grants and is retained on retry, including
over-capacity evidence. An oversized snapshot sends no grants; Retry keeps that
snapshot even after destination membership changes. **Start over** is required to
capture a different audience. Confirmed grants are skipped; direct selections never
vanish when choosing a channel. Saved grant IDs, link IDs, unknown delivery, concurrent
remount guards, stale Retry/Start over guards and chat lifetime fencing remain.
Partial failures distinguish confirmed access from unconfirmed link posting. Pending
buttons retain their label and block duplicate activation. The first pending share
keeps its existing footer actions: saving an in-flight receipt does not insert a
disabled **Start over** button. Recovery offers Start over after failure and keeps
that button in place, disabled, while Retry runs. Changed eligibility
shows inline access-change recovery and disables Share/Retry until access recovers. Closing a view does not
cancel submitted work; a superseded visit receives no completion navigation.

Share attempts target an existing channel or the source for people-only access,
with the same exact link on retry. Share cannot create channels or change their
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

Share’s bottom-left footer, the Solo chat header overflow and the Solo row menu
offer **Convert to channel** for the viewer's own Solo chat.
`src/features/solo/ConvertToChannel.tsx` reuses the shared Dialog, Field,
Private/Public RadioGroup and Button. Private is the default; Public warns that the
community can view the full existing history. Draft recipient selections are never
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
state). Later shares can still grant access and post their link. Unrecorded people
appear under **Other access**; known agents retain their individual display rule.
The warning does not promise individual direct-share provenance that was not saved.

The attempt captures the original channel roster separately from its combined
retry audience. Only confirmed grants merge into history, including partial
successes. Repeated shares to the same destination coalesce; direct choices remain
individual even when also in a channel segment. Completed grant/link operations
retire if history saving fails; the warning stays visible and Done never replays
those operations.

Recorded channel recipients/counts intersect the confirmed original-share union
with verified current source-chat access, including the viewer when present.
Current destination names may update labels, but later joins/departures do not
change history or synchronize access. Selecting a recorded destination shows its
current chooser disclosure instead; source members not covered by that disclosure
remain under Other access or their recorded direct share. Failed source evidence
shows loading/retry, not an access claim. Historical or other-device provenance is
never inferred from roster overlap, links or display names.

## Required PR-description limitation note

> Sharing segments are display-only history saved on this device, partitioned by
> account and community. They survive reload/restart on this device but do not sync
> across devices and are not backfilled for earlier shares. Human/unclassified access
> without recorded provenance is grouped in the default-closed Other access
> disclosure; known chat agents remain individual rows. Channel
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
acceptance. At 390px with 200% text, Convert to channel can exceed a row by itself;
the shared footer retains horizontal scrolling for that single oversized control.
Main's opaque modal fill supersedes the earlier translucent dialog screenshots;
anchored floating surfaces retain their shared treatment.
The configured desktop/Vite remain running. PR preparation performs no live share,
settings write or app restart.
