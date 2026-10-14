# Pair mobile

`buzz.pairing` is an enabled-by-default bundled Settings plugin. Settings →
Plugins can disable it independently. The plugin contributes `mobile` through
`ctx.settingsCards.register` in the Account group, using the existing Settings
shell, navigation and contribution lifecycle. It reads the existing
`communityReader` capability without acquiring another relay session.

The plugin owns its React UI and the short-lived IPC client. The native host
uses the app's existing IdentityHost for account access, NIP-11 pairing-route discovery,
ephemeral NIP-42 authentication, encrypted NIP-AB exchange, QR generation, and
session cancellation. No account private key crosses IPC. Plugins are trusted
in-process code, as elsewhere in this app; this is an ownership boundary, not a
new plugin security sandbox. The frontend CSP is unchanged.

## Behavior

1. With an active account, the selected community prefills the address. Without
   a live app account, **Use existing Buzz account** reads only the public identity
   from the current app identity. The user supplies a community address.
2. Opening Pair mobile automatically verifies the public identity against the
   saved native account, opens a dedicated pairing socket, and waits for subscription
   readiness before showing the QR. QRs automatically renew while the section
   remains open, before the supported sidecar’s 120-second connection cap. Desktop budgets 115 seconds from before
   connecting, including setup, so the visible lifetime is shorter than two minutes.
   The protocol also expires no later than two minutes after display. Connection
   failures show **Try again** instead of retrying indefinitely.
3. A compatible phone advertises encrypted `desktop-code-v1` support. Desktop
   generates a separate random six-digit code that is never sent in the QR or
   challenge. The phone submits the entered code; desktop verifies it with a
   five-attempt budget before sending the encrypted account payload.
   In the code-entry flow, the code protects against a captured QR. A QR holder
   can instead request legacy comparison, which still requires explicit desktop
   approval. Code entry does not protect against a live observer: someone who can
   watch both the QR and the code can race the phone and enter the code. Do not
   pair while sharing, recording, or otherwise exposing the screen to an untrusted
   observer. `desktop-code-v1` extends NIP-AB; the NIP-AB/Tamarin
   source-confirmation model in `crates/pairing/src/NIP-AB.md` does not establish
   this extension's observation resistance.
4. Older phones retain explicit **Codes match** confirmation and a **Cancel**
   action; Cancel sends `user_denied` before disposing the session. Code-entry
   phones also have Cancel, but no desktop
   confirmation action.
5. **Phone paired** means the phone acknowledged the transfer. Current phone
   versions can acknowledge before saving the account, so desktop asks the user to
   check that the account is signed in on the phone. The mobile fix is separate
   `block/buzz` work.
   If a sent transfer times out or loses its connection awaiting acknowledgement, **Check your phone**
   preserves the uncertain outcome and requires a deliberate new attempt.
   Closing or reloading the window, leaving the Settings section, switching accounts/communities, disabling the
   plugin disposes the attempt, with a bounded best-effort `user_denied` notice
   only before transfer publication. After publication, closing the socket cannot
   retract the account or interrupt the phone's import, so cancellation shows
   **Check your phone** (or a result the phone already reported), not
   **Pairing was canceled**. Native cancellation remains terminal until an explicit retry
   or reopening the pairing section. Retries use a fresh native session.

Pairing uses the current native app identity through a purpose-bound
`IdentityHost.with_pairing_key` operation. The public viewer is checked before producing
the encrypted transfer payload. It never reads or mutates the original Buzz
credential store. Browsers explain that pairing requires desktop. Live development
with `BUZZ_DEV_VIEWER` uses the separate broker identity, so pairing is unavailable
there; start `BUZZ_DEV_VIEWER= bin/just desktop` (also overrides a viewer
pin in `.env.local`) and use the native identity setup for the same account to
test pairing. The mobile implementation remains in `block/buzz`.

Only secure community origins and secure advertised pairing URLs are accepted.
Redirects are disabled for discovery, setup traffic is bounded, and both early
offers and late authentication challenges are handled. Cancellation prevents
subsequent work; it cannot retract a payload already delivered to the phone.

## Verification

- `crates/pairing`: imported protocol tests and vectors from PR #8085, pinned to
  `ac0ad7c3004683e5db813492846d787404a2b475`; see its README for provenance.
- Native tests: account mismatch, code-entry and legacy transfers, phone import
  failure, stale-session cancellation, secure destination validation, and actual
  local WebSocket subscription/authentication exchanges with temporary keys.
- Frontend tests: late start/status cancellation, replacement ordering, cleanup
  failure, and legacy-only desktop confirmation. App composition verifies real
  plugin enable/disable and registration lifetime.
- Browser journeys: real Settings navigation and plugin UI with fixture IPC in
  Chromium and WebKit. These do not prove a live phone handoff or OS Keychain UI.

Run focused pairing, Settings lifecycle and native identity checks, including
`bin/cargo test -p buzz-pairing` and native pairing tests.
Hosted CI runs `cargo test --workspace`, which includes the pairing crate.


## Verified native secret release

The executable `buzz-pairing-policy` crate owns production protocol state and
native release admission. Cargo compiles the same `verus!` executable bodies
that Verus checks; this is not a separate model copied from those decisions.
`PairingSession` owns crypto/parsing adapters around `Protocol`. The native
registry owns `Native` under its existing mutex. `Identity` uses `Custody<Key>`
as its actual key state. Proof-only views and trace lemmas are erased from the
ordinary build.

For traces composed of these checked transitions, every native release grant
has an authorization witness for the same native generation, pinned human,
selected community, session and locked peer. Source authorization requires
explicit legacy approval in negotiated legacy mode, or an authenticated matching
code submission in negotiated code mode before the permanent five-guess budget
is exhausted. Malformed authenticated submissions consume guesses. Issuance is
once per session; fallible challenge/proof construction cannot reopen it or
refund guesses. Target confirmation and source reverse-flow receipt retain
separate role/state checks. Terminal protocol states are absorbing.

Admission allocates a monotonically increasing native generation, independent
of the renderer ID, refusing counter exhaustion and closed registries. Session
binding is once per generation. Release checks the deadline, revocation,
provenance and unused transfer right under the same mutex as cancellation and
close. The common native transition contract and trace induction show that a
revoked/superseded generation cannot get a new grant, and a generation cannot
reset its release right or change its admitted frame. `Release.frame()` proves
that initial publication and every AUTH replay use identical signed ciphertext
bytes. Complete requires an incoming validated success acknowledgement from the
admitted payload's peer/session; local completion construction and relay receipts
cannot create that witness. Transport failure/expiry/cancellation after admission
preserves possible delivery. Renderer IDs with retained outcomes cannot be reused
to alias a different attempt's status; unreleased pending replacement may reuse
an ID while native generation checks still fence the old worker.

### Refinement and conditional adapters

Verus proves policy executable bodies, their authorization/type invariants and
protocol/native trace lemmas. It does not mechanically verify all surrounding
Rust dispatch, serialization or dependency internals. The following adapters are
explicit conditions of the composed theorem, backed by the production ownership
boundaries and owner/integration tests:

- **Cryptography and random generation:** valid secp256k1 keys, ephemeral signing,
  NIP-44 authenticated encryption/decryption, signatures, ECDH/transcript hashes,
  QR session derivation and the desktop code RNG supply the claimed authenticated
  facts. Crypto errors do not authorize release. The verified policy performs the
  actual code comparison; it assumes no comparison result from an adapter.
- **Parsing and authenticated dispatch:** `validate_event_common`,
  `validate_event_from_peer`, `decrypt_message` and offer/code parsing validate
  event signature/kind/recipient, deduplication, locked peer, session/version and
  negotiated mode before supplying policy inputs. Failed/duplicate/out-of-order
  inputs cannot advance those checked transitions. Imported protocol vectors
  and native socket tests exercise these adapters.
- **Exact identity and ciphertext serialization:** `with_pairing_key` holds
  custody's mutex while selecting the Ready key and issuing its pin/community
  binding. The serializer checks the actual key and exact community against that
  binding and produces private `Prepared` fields. Consuming `Prepared::encrypt`
  is the only constructor of the private sealed `Transfer`; it encrypts that
  exact plaintext and retains that binding. Its proposal uses the exact signed
  event frame. Native dispatch carries this sealed object separately from
  controls, never inferring a payload from status or event-list position.
- **Persistence and key derivation:** a successful secure-store read/parse supplies
  a valid candidate; a successful create-only write precedes Ready installation.
  Denied/malformed reads return errors before Missing/generation. `Custody`
  proves failed writes cannot install Ready and Closed cannot restore/save/bind.
- **Clocks, mutexes and runtime:** the deadline comparison supplied at release is
  a truthful monotonic-clock observation inside the registry lock; the protocol
  deadline conversion and connection budget share the documented clock epoch.
  Registry and identity mutexes serialize their respective operations. The
  sign-out callback closes custody, then the registry. The marker write is not
  the pairing cutover. Already admitted grants may still send after close and
  retain an uncertain result; no no-network-after-close claim is made.
- **Sockets and publication routing:** initial payload publication and AUTH retry
  both own `Release` and call its immutable frame accessor. Current ordinary
  event sends/cache entries originate only from challenge, SAS proof, rejection
  and abort controls; REQ/AUTH use ephemeral session keys. This caller audit and
  the native socket regression establish dispatch refinement, conditional on
  WebSocket framing preserving bytes. Delivery receipts are not phone success.

The theorem does not establish computational crypto secrecy, constant-time
machine execution, OS/allocator/dependency-copy erasure, phone persistence,
hostile-plugin isolation or arbitrary same-user code containment. Owned serialized
plaintext uses `Zeroizing` on encryption errors, without claiming unowned copies
are erased. The main WebView and plugins remain trusted as documented above.
Other deliberate identity-export commands are outside the pairing IPC theorem.

### Reproducible verification

Activate Hermit and run:

```sh
scripts/verify-pairing.sh
bin/node scripts/verify-pairing-mutations.mjs
bin/cargo test -p buzz-pairing -p buzz-foundation --locked
```

Verus is pinned to release `0.2026.10.04.426d8b0`, revision
`426d8b01e7ffb910a36c15e1f870ff985bb61eef`, compatible with repository Rust
1.98.1. `bin/packages/verus.hcl` pins archive checksums including bundled vstd
and Z3 4.16.0; `Cargo.lock` and the policy manifest pin the matching vstd crate
and its macro dependencies. No global toolchain change or rustup fallback is
needed. The verification command rejects missing tools, disabled Cargo opt-in,
zero verified functions and proof errors. The **Verified pairing release** CI
job runs verification and security mutations and participates in **CI required**.

Mutations weaken peer/session/provenance, mode/issuance/budget, freshness,
revocation/closure, distinct release, deadline, retry bytes, persistence and
success-acknowledgement guards in copies of the actual production owner. Each
must fail verification with proof errors, then the copy is restored byte for
byte; the checkout hash must remain unchanged. Native tests also exercise a
controlled release-time clock, same-renderer-ID replacement, sign-out ordering,
and real local TCP/WebSocket identity release/AUTH replay/success in both modes.
These Linux synthetic checks do not establish attended macOS/Windows GUI,
secure-store consent, a durable phone import or human acceptance.
