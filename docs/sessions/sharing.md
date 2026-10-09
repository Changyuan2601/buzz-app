# Sharing a live session

The baseline uses ordinary channel membership and private client-side Me
organization; see [Me and sessions](README.md). This document describes the
destination-link flow in Messages and unified Me sharing. Both grant access to
existing history, not a snapshot.

## Me: share in place

Me uses the existing channel-details controls: editable current name, Private/Open
and Ongoing/Temporary, plus optional people. Existing agents remain members without
being re-added or woken. Copy link and cancelling do not mutate access or placement.

Submission freezes the settings/base and people, confirms grants while the channel
is still private, saves the settings with signed fresh authority/readback, then
removes Me placement and opens Messages. The standalone session marker becomes an
empty description so normal Messages behavior applies. A default Share therefore
writes metadata once; unchanged visibility and TTL are omitted. Public sharing
requires a second confirmation of history exposure. The Temporary control explains
that expiry automatically archives the conversation; it does not delete history.

A settings or placement failure retains confirmed work and frozen Retry intent.
Confirmed grants are skipped; an uncertain details save is checked, never blindly
republished. A confirmed TTL is not resent, avoiding a reset of the cleanup deadline.
Conflicting metadata stops the attempt. **Check channel settings status** remains
available for an uncertain save, including after Start over. Closing/navigating does
not cancel submitted work; completion cannot navigate a superseding visit.

This is not an atomic grant/settings/placement transaction. There is no separate
placement-only Move fallback: Share requires verified owner/admin details authority
and the connection’s existing details writer. Destination-link behavior below is
unchanged.

## Current behavior

- **Share** in a Messages session heading opens a compact dialog. **Everyone in this channel** (default) means all *current* destination-channel roster keys, **including agents**. After optional invitations separately chosen for a new destination are confirmed, a strong fresh kind-39002 destination roster read freezes its exact non-viewer keys for this submitted attempt and retries. Missing/malformed/ineligible membership, archived identities, invalid keys or >100 recipients fail visibly; no namesake join or silent agent/archived filtering. Later destination joiners do not acquire session access. Known agents get the ordinary `role=bot` membership invitation but sharing does not notify, wake, start, configure or own a runner.
- **Selected people** is deliberate human selection by exact public key. The human picker hides identities *known* to be agents by existing profile/agent-choice evidence (unknown classification is not proof of humanity); submit rechecks known-agent and archive admission. Picking a person does not automatically include their agents. Already-access people can be shown as unavailable. In a new destination, **people to add to that channel** and **people to grant session access** are independent selections. With Everyone, confirmed new-destination invitees enter the fresh destination roster before the session audience is frozen. No general member-add behavior is widened.
- All grants target the private session's own signed membership roster. They grant normal **read and participate** access, not read-only access. No parent/destination inheritance, future-member synchronization, or revocation on leaving the destination. The existing composer, notification/mention rules and agent recipient routing remain in charge of deliberate sends. Detailed owner-private ACP activity is not shared.
- **Copy link** copies `buzz://channel/<session-id>` only: no grant, saved selection, post, channel creation, invitation or permission mutation. A recipient needs independent session access. Sharing posts one ordinary kind-9 destination message with the neutral `Session · short ID` link chip. An authorized click opens the existing live session transcript/composer in that destination's side panel while preserving the destination and the Sessions entry; unauthorized access does not expose transcript content. The link is bound to the selected community rather than portable across communities.
- A submitted share freezes intent in a `RelaySession`/source-ID-scoped `ShareAttempt`, including new-channel ID, recipient keys, per-person grant operation IDs and link event ID. Creation and membership writes reuse existing channel creation, member addition, signed-roster confirmation and durable Outbox operations. Partial confirmations appear in one actionable error; retry keeps exact intended keys and does not create a second destination or replacement link. A synchronous running guard prevents concurrent remounts; a stale **Retry** cannot become a new share after completion/replacement. A settled saved attempt exposes **Start over**; this clears choices but preserves submitted operations, confirmed grants, created channels and placement. A new attempt may post another link.
- Link delivery uses the actual `session.messages.send` Outbox event ID. A caller-owned recovery marker retains only this link through a signed echo that otherwise removes it from pending; accepted/seen is acknowledged afterward. If Start over or a lost in-process attempt leaves a protected receipt, Outbox Retry reuses its exact event ID; Remove acknowledges a matching delivered session-link receipt before dismissal. Unknown/in-flight evidence remains protected. When a saved ID is absent, strong exact-ID readback can confirm the matching authored destination event. Missing/error evidence remains **unconfirmed** and does not automatically post another link. This is not a transaction spanning creation, invitations and link posting, nor a persisted whole-share restart journal. Rejected, expired invitations permit replacement only after explicit failed-receipt dismissal; missing unknown/accepted evidence does not authorize a fresh grant.

## Owners and integration notes

- `src/bundled/sessions/SessionShare.tsx` and its CSS own the dialog, separate destination/session picks, Base UI anchored results, and presentation of errors. The compact dialog uses opaque feature-scoped elevated surfaces and existing semantic tokens; the results popup is mounted inside the Dialog focus tree, viewport-bounded and keyboard-dismissible. `src/features/sessions/share.ts` owns the exact roster snapshot, grants and link receipt. `share-attempt.ts` owns only the in-process submitted intent. `src/features/channel-members/members.ts` retains the signed-roster/Outbox member-add authority, with a narrow session-participant/Everyone-agent path. No foundation, native host, broker, relay or key configuration was changed.
- `SessionsPage.tsx` and `ChannelsPage.tsx` provide entry/routing; `ConversationTab.tsx`, `SessionPresentation.tsx` and the pane-only `ChannelTabs.module.css` reuse the existing session conversation and widen its side-panel layout without changing standalone Sessions. `MessageLink.tsx` and `LinkPreview.module.css` render the quiet link chip.

## Evidence and next validation

- Synthetic signed-session/Outbox service tests: `src/features/sessions/share.test.ts`, `share-attempt.test.ts`; React/RTL dialog test: `src/bundled/sessions/SessionShare.test.tsx`. They cover frozen Everyone recipients including bots/no wake, separate new-channel invite/session access, selected recipient retry, signed echo before publisher return, exact-ID readback, missing evidence fail-closed, and duplicate/stale Retry fences.
- Actual app browser fixture: `tests/browser/session-sharing.spec.mjs` in Chromium and WebKit covers chip-to-sidepanel/composer wiring, settled compact dialog and opaque light/dark styles, deterministic held search response, human-only results, audience-toggle footprint, selected-recipient removal, popup Escape/keyboard/scroll/viewport and fail-closed error. The fixture uses synthetic identities and a synthetic host; it **does not prove packaged native signing, real relay ACL enforcement or live agent behavior**.
- **Human try (read-only first):** in the already-running HMR app, open a private session and inspect Share → Everyone/Selected, destination picker, human-only results and compact keyboard behavior. Copy a link and verify that recipient access has not changed. Before any live Share/send/invite, explicitly coordinate a permitted account/channel and inspect signing, roster authority and partial-write risk. Native packaged signing, real-relay ACL, cross-account membership, live agent wake/no-wake effects and final human acceptance remain unverified. Do not mark review or release complete based on synthetic checks.

## Deferred product work (not validation claims)

Read-only sharing (P2); future destination-member inheritance/revocation synchronization; new relay semantics; fully persistent composite app-restart recovery; cross-community link portability or retargeting; sharing owner-private activity; and further visual polish. Intentional fresh Share after another completed attempt is not blocked merely because its unsent dialog was already open; only saved submitted Retry is fenced.
