# Assistive UX

Assistive UX is an always-on application service alongside Pages and Panels, not
an enabled plugin or a UI system. `features/assistive-ux/catalog.ts` is the auditable
owner of stable experience IDs, their purpose, and contextual eligibility rules.
The service owns remembered lifecycle intent. Builders own presentation, copy,
actions, and any flow progress; an experience may have one UI piece, several, or
none. Visible consumers use Buzz's existing design system, not an assistive subset.

## First lifecycle: eligibility → dismiss → remember

`ctx.assistiveUx` exposes three operations:

- `snapshot(viewer, id, facts)` returns whether the experience is eligible. Each
  ID has its own typed facts; unrelated experiences do not inherit thread fields.
- `subscribe(listener)` observes dismissal/storage changes. Builders still
  subscribe to their own context and product state.
- `dismiss(viewer, id)` records an explicit dismissal, returning `saved`, `unsaved`,
  or `unavailable`. It does not mean accepted, completed, or applied.

Reading eligibility, mounting, typing, sending, closing, or switching channels
never records exposure or retires an experience. Builders decide when and how to
present help; temporary loading, recovery, focus, and rendering decisions stay
with them. The service never renders, performs actions, or changes settings,
permissions, recipients, notifications, or sending. Eligibility is presentation
policy, never authorization or a reliable basis for automatic side effects.

A future experience may need completion, acceptance, progress, or undo. Add that
outcome only with a designed consumer and its behavior tests; never call dismissal
to mean successful completion. This foundation has no generic flow engine,
arbitrary state bag, tracking, counters, timers, tours, reset UI, or auto-apply.
Actual product preferences remain with their feature, separate from this memory.

## Account and persistence contract

A versioned localStorage marker is keyed by account public key and experience ID:
`buzz-assistive-ux.v1:<viewer>:<id>`. No channel or community is in the key. The
account comes from the consumer's session, never a global selected-account value
or an anonymous device fallback. Invalid/missing accounts are ineligible and
cannot record dismissals. Markers are read before the first eligibility result,
without asynchronous hydration or a new host endpoint.

Each marker is independent, so simultaneous dismissals cannot overwrite a shared
map of other experiences. Local subscribers update synchronously; browser storage
events refresh other windows. Missing, malformed, or unreadable evidence leaves
assistance eligible: failing to read must not break the surrounding task. Read
failures are not separately reported; eligibility is not proof of durable state.
Failed writes retain dismissal for this service's lifetime and return `unsaved`,
not a false success. Consumers own any failure feedback and retry interaction.
Shutdown removes listeners and fences retained handles.

Dismissals survive channel changes, leaving a community, and restarting in the
same storage profile. Ordinary native sign-out keeps them, like other local
preferences; signing back in as the same identity restores that account's memory.
**Sign out and erase** removes them through the existing app/WebView data wipe.
No new sign-out hooks or keep-list entries are added. Existing evidence:
`features/identity/SignOut.tsx` explains the two choices; `src-tauri/src/sign_out.rs`
keeps only agent registries during a wipe, removing the app/WebView storage.
Browser site-data clearing also removes markers. Separate browser origins and
desktop data profiles have separate storage; no relay sync or cross-device promise.
The community-scoped developer cache clear does not reset account-wide assistance.

## First definition and deferred consumer

`threads.new-thread-placement` names assistance explaining where a new channel
thread appears and who can read it. Its product rule requires the new-channel-thread
context, known stream/forum channel type, and positively known non-Me context;
DMs, Me, unknown Me classification, session replies, other surfaces, and unknown
channel types do not qualify. It contains no words to render,
component, focus policy, or action callback. The first consumer will own the
requested teaching copy and its design, preserving mention behavior and making no
privacy claim (public channels can also be readable by nonmembers).

No product consumer uses the service yet. Composer integration is deferred:
its current implementation is uncommitted work in `channel-sessions-me`, which this
foundation does not modify or copy. That consumer must prove the actual eligibility,
presentation or action, explicit dismissal, account isolation, and persistence at
its integration boundary. This is an approved foundation-first split, not a claim
that the user-facing experience is complete.

## Evidence and inspiration

Colocated service tests cover eligibility, account isolation, explicit dismissal,
restore into a new instance, storage failure, storage-event refresh, and disposal.
App composition tests exercise injection independent of plugin enablement. There
are no visual components or specimens to validate in this foundation. These tests
do not establish real cross-window browser coordination or packaged native restart
and erase behavior; those remain acceptance checks with the first consumer.

Berd supplied lifecycle ownership and separation from settings. Its device-global
state, exposure counts, retirement reasons, automatic setting changes, and broader
signal/undo plans are not carried over without a real Buzz requirement.
