# User-facing retry surfaces

Transient **reads** recover quietly before their existing Retry control appears.
The finite policy is one initial attempt and three retries, with equal jitter
under 1/2/4-second ceilings. Existing background recovery owners remain in place.
See [read recovery policy](relay-queries.md#finite-read-recovery).

This inventory maps controls to operations; it does not authorize automatic
replay of every action labelled Retry. Authorization, validation, admission
cooldowns, local setup failures and ambiguous native failures remain actionable.
No UI copy or control style changes are required.

## Finite read owners

| Controls / consumers | Existing operation owner | Recovery |
| --- | --- | --- |
| Hidden conversations | `relay/channel-lifecycle.ts`, `ChannelInventory.tsx` | Four-attempt refresh; retain confirmed hidden IDs. Scoped invalidation keeps the same budget. |
| Retry channel permissions / Delete check | `relay/channel-lifecycle.ts` | Retry authority reads only. Unrelated shared-read retirement rereads immediately under the same deadline without spending a failure attempt. |
| Channel settings load | `relay/channel-details.ts` | Retry `load`; save and save-confirmation remain separate explicit operations. |
| Channel member/participant/role lists | `channel-members/administration.ts` | Retry `refresh`; membership mutations are single operations. Names use the profile directory. |
| Retry profile / Retry users / member and manager names | `relay/profile-directory.ts` | Retry missing-profile batches, retaining existing heads and coalescing callers. Foreground promotion during backoff changes the next attempt's priority. |
| Profile settings / community profile inspection | `communities/api.ts`, `ProfileSettings.tsx` | Session reads keep their single finite owner; direct-host reads own a bounded retry. Each profile read retains a 12-second bound and a caller signal. Save remains explicit; dispatched confirmation keeps its own bounded lifetime. |
| Retry people / community search / recipient directory | `session.ts` public search and directory boundary | Finite retries; preserve the existing single immediate access-invalidation reread, cache/session cancellation and request deadline. |
| Retry messages in search, including later pages | `session.ts` public `readPage` / `readRemote` | Finite retries at the public consumer boundary. Internal verified readers are single-attempt. |
| Retry channels / channel completion search | `channels/usePublicChannelSearch.ts` | Retry the finite name lookup under its typing/scope controller. The channel store retains the prior useful directory. |
| Agent browse, relay notes, Huddle discussions, profile observations, workflow lists/landing/runs | `session.ts` public reads and `observe().refresh()` | Finite retries; retained views keep loaded data while refreshing and coalesce active refreshes. |
| Retry inbox | `relay/inbox-feed.ts` | Retry addressed history and overlay reads; retain incomplete-target fences and existing access/purge controllers. |
| Retry reminders | `relay/reminders.ts` | Retry the history query; reconnect supersedes its read generation. Reminder create/snooze/complete/cancel remain explicit writes. |
| Retry thread / media comments | `relay/threads.ts` | Retry finite selection, root and page reads under existing controllers. Cached membership does not authorize a network retry. |
| Retry older messages | `relay/store.ts` pagination | Retry continuation reads only; initial/head reads retain session recovery. Loaded rows remain available. |
| Retry emoji / custom emoji catalog | `relay/emoji-directory.ts` | Retry catalog refresh; publishing sets and uploads remain explicit. |
| Retry GIF search | `relay/gifs.ts` | Retry typed network/408/429/5xx read failures; unavailable capability and invalid provider data remain explicit. |
| Retry agents / agent library | `agents/library.ts`, `agents/choices.ts` | Retry the read-only library source. Choices continue to project existing sources rather than introduce another read loop. |
| Retry archive information | `relay/identity-archives.ts` | Retry the visibility snapshot within its existing deadline; invalid or truncated authority is never treated as an empty archive. |
| Retry loading memories | `agents/memory.ts` mounted views | Retry the host read within its existing ten-second lifetime. Decode/permission failures remain explicit. Runtime memory reads keep their separate owner. |
| Retry older config revisions | `agents/agent-config-history.ts` | Retry the requested history page; retain prior revisions on failure. |
| Repository metadata / Retry files / commits | `session.ts` repository read boundary, `repos/git.ts` | Retry immutable metadata/Git reads. Shared browser/native validation still owns destination, signatures, bounds and snapshot parsing. Missing/invalid Git requests remain immediate, including 404 not-found. |
| GitHub panel / PR content | `bundled/github/data.ts`, `object.ts` | Retry public API network/408/5xx and typed GraphQL internal/unavailable failures. Public quota, auth, missing objects and ambiguous CLI setup remain actionable. |
| Staff lists, searches, details and read-only lookups | `bundled/relay-staff/session.tsx` | Explicit read-route allowlist; retry typed intercepted/ambiguous transport failures. Scope cleanup suppresses obsolete results and future requests. |
| Staff attachment preview | `bundled/relay-staff/Feedback.tsx` | Retry reading preview bytes. Native Save remains explicit. |
| Retry models / provider catalogs / read-only history/config tabs | Goose/Pi tab read owners; Claude setup; Codex catalog owner; Builderlab read-route owner | Retry typed transport/timeouts or stopped Pi-host reads. Preserve auth, validation and setup errors. Builderlab limits this to list/catalog endpoints. Codex shared model listing stays single-attempt. Initial turns also await catalog discovery: its retries share a 30-second deadline, and each turn can cancel its own wait without cancelling the shared check. |
| Retry voice note / video resource loading | `messages/use-media-read-recovery.ts` | Browser network-error code 2 gets three reloads after the original failed load. Closing, source changes and voice-note cancellation stop future reloads. No call to `play()` is added. |

Paths above are relative to `src/features/` unless a bundled/app component is
named. Staff native APIs do not expose in-flight abort: an already-issued request
can finish after cleanup, but its result and further retries are discarded.

## Existing automatic owners retained

| Controls / consumers | Owner and disposition |
| --- | --- |
| Retry connection / Retry live updates / Retry now | `relay/service.ts`, live transport and `relay/recovery.ts`; existing indefinite background recovery stays intact. |
| Retry channels in sidebar/profile; initial conversation messages; catch-up heads | `relay/store.ts`, session live recovery; preserve transient state, cooldown and reconnect-triggered repair. |
| Retry templates / teams / sidebar preferences | Channel-kit and preferences recovery sources; no second finite wrapper around their internal reads. |
| Status editor readback | `relay/user-status.ts`; retain existing bounded readback retries and explicit status publication. |
| Retry config/workspace/team reads | `agents/config-sync.ts`; retain its existing bounded retry owner around lookup and current/head reads. Shared artifact/read helpers stay single-attempt. Save and revert remain explicit. |
| Usage refresh / Try again | `bundled/usage/UsagePage.tsx`; retain its existing single 500 ms retry rather than stack another owner. |
| Avatars | Shared Avatar recovery at 2/10/30 seconds; retain that owner. |
| Pairing checks | Existing polling owner; permission/authentication and pairing confirmation remain explicit. |
| App update checks | `updates/updates.ts`; retain scheduled checks. Download/install/relaunch remain explicit lifecycle actions. |

## Explicit actions retained

| Controls / consumers | Reason |
| --- | --- |
| Send, Outbox, reaction, edit, delete, report, moderation, invitations, feedback | Mutations or ambiguous delivery. Existing durable operation IDs and explicit confirmation/retry remain authoritative. |
| Channel creation/join, hide/unhide, sort/filter/move, Canvas/todos, unread updates, agent configuration/sharing/archive/stop, workspace actions | User intent or persistence/publication; no automatic replay. Read-only precursors use the owners above. |
| File/media downloads, native Save, copying links/images, avatar/upload retries | User-directed local writes, OS dialogs, clipboard or uploads. Preview/data reads are covered separately. |
| Appearance/notification/shortcut/search/developer settings, local drafts and repository-folder choices | Local persistence or device configuration; unknown native failures do not establish a recoverable network read. |
| Secure storage, identity restore/reveal/setup, OAuth sign-in, microphone/playback permission, local provider installation | Authentication, permission or setup can require interaction; do not repeat prompts or installation silently. |
| Media errors 1/3/4, unsupported source/listener, playback rejection | Cancellation, decoding, unsupported resource or browser permission; only explicit media network failures receive reload recovery. |
| Plugin import/install/update/rollback/delete, page/sidebar/plugin/module crash recovery, navigation/window-opening failure | Code/process lifecycle or interactive setup; preserve explicit recovery. Read-only navigation data uses the owners above. |

## Validation boundaries

Deterministic tests cover shared budgets, nested exhaustion, admission pauses,
caller/cache/access/dispose cancellation, retained views, staff outcomes, immutable
Git validation, provider read versus write replay, and media reload cleanup.
Existing manual-recovery presentation tests use terminal failures; transient API
failures have separate owner tests with controlled clocks.

The representative app journeys exercise hidden-conversation exhaustion/manual
retry and relay recovery from edge/VPN errors in Chromium and WebKit. These browser
checks do not establish native signing/IPC, a real relay, native media playback,
or every screen/OS permission flow.
