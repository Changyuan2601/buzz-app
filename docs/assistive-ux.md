# Assistive UX

Assistive UX is an always-on app service alongside Pages and Panels, not a plugin
or a UI system. Its catalog owns stable experience IDs, purpose, contextual
eligibility and retirement rules. Builders own copy, presentation, placement,
actions, and flow progress. An experience may have one UI piece, several, or none;
visible consumers reuse Buzz's design system. Product settings stay separate.

## Consumer contract

Capture a concrete community session with `ctx.assistiveUx.forSession(session)`.
That session's identity and normalized community origin bind every operation;
changing the globally selected community cannot retarget a pending write.

- `ensure()` starts lazy progress restoration/synchronization. No finite progress
  query or host codec call is added at app startup before a consumer asks.
- `eligibility(id, facts)` returns `eligible`, `ineligible`, or `unknown`.
  Initial/loading/failed remote evidence is unknown, not a first-time user.
  Known terminal progress still suppresses help while offline.
- `snapshot()` and `subscribe()` expose remembered facts, pending count, status
  and errors. The consumer also subscribes to its own contextual facts.
- `record(id, "seen" | "dismissed" | "completed")` records a distinct add-only
  fact. `saved` means durable **local intent**, not relay success; `unsaved` honors
  that fact in this session's memory without claiming it survives restart.
  `unavailable` means the captured session has no usable host/identity or retired.
- `refresh()` retries loading and pending publication; connect and relevant live
  events also reconcile demanded progress. There is no new timer or retry loop.

Reading eligibility or mounting UI never records an exposure. Builders explicitly
record a fact at the actual designed boundary. The first New thread definition
retires on dismissal or completion, not merely seeing it. It requires new-thread
context, known stream/forum type and positively known non-Me classification.
Other app actions can make help irrelevant through existing feature state;
assistance does not duplicate that state or grant access.

## Relay and local memory

Facts belong to **identity + community**, independent of channel and device.
Signing into the same identity and community on another device retrieves them.
Different communities do not automatically share progress.

Each outcome has its own kind-30078 addressable event, so concurrent devices cannot
replace unrelated progress or overwrite completion with a stale seen fact. Every
write means the same immutable true fact; there is no false/reset/deletion state.
The host derives an opaque `buzz-assistive-v1:<HMAC>` coordinate from the labelled
community/experience/outcome tuple under the NIP-44 self conversation key. Content
is self-encrypted, versioned and community-bound. Native Rust and the development
broker admit only bounded registered facts, exact tags and valid own signatures;
plugins receive neither private keys nor general signing/decryption capabilities.
Existing sidebar, recipe and read-state payloads are not broadened.

The session makes separate strong finite reads for each exact coordinate, avoiding
combined result caps hiding other facts. Host-verified decode establishes remote
facts. Local pending intent and exact signed envelopes are saved before publication;
unknown delivery keeps the envelope for retry. A verified equivalent coordinate
head confirms the fact even if another device's event won replacement ordering.
Expired envelopes may be renewed because the underlying fact is immutable.

The local cache uses one checked marker per scope/fact, not one shared mutable map.
Storage events merge peer-window progress; reconnect and the existing shared live
route trigger catch-up. Access/cache reset cancels obsolete work; session disposal
fences retained handles. Missing/corrupt/unavailable storage is reported, not silently
overwritten as empty progress. Pending writes require local durability.

No analytics, clickstream, counts, content capture, flow engine, automatic settings
changes, or reset UI is included. The first catalog has three possible markers;
batches are capped at 96 markers and events at 4 KiB. Adding experiences requires
coordinated catalog/host validation changes and review of the shared kind-30078
read-state discovery budget. Publish only new facts; generic relay replacement may
retain superseded history.

## Privacy and erase

Self-encryption hides progress contents, not event existence, generic namespace,
timing, size, or author metadata from other community readers. This is not an
extra author-only relay policy. Ordinary sign-out preserves local and remote
progress. Sign-out-and-erase clears app/WebView data **on this device**; it cannot
erase synchronized relay facts, which can return after signing in. Community cache
clear invalidates reads without resetting progress. Local-only v1 dismissals are
not automatically exported into communities; that older draft never had a product
consumer, and no migration/silent community fan-out is added.

## Verification and remaining integration

Tests exercise the real browser-host encryption/signature codec through independent
progress owners, offline pending restore, identity/community isolation, outcomes,
peer-window refresh, cancellation and recovery. Shared known-key vectors establish
native/browser coordinate parity. Native IPC tests exercise purpose admission,
foreign/schema/tag rejection and refusal through generic write routes. Broker HTTP
and native-adapter tests cover the dedicated routes. These fixtures do not establish
real deployed-relay retention, packaged two-device acceptance, or a desktop restart.

No product UI consumes this foundation yet. New-thread composer integration remains
a separate designed consumer; protected `channel-sessions-me` work is untouched.
Before marking the overall feature ready, exercise two independent installations
on the same identity/community, offline/reconnect/restart and human acceptance.
