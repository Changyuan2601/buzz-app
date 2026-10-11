# Local agent controller

This crate backs the native `agent_control_*` commands. No frontend feature calls
them now: Agents2 uses the separate `app_agent_*` commands (see
[agents](../../docs/agents.md)). It owns native configuration/import and listener process lifetime without Tauri,
React, or the old desktop manager. The `Controller` must be called by one serialized
native host owner; dropping a page is not dropping this controller. Source and
fixture validation do not establish live readiness; the attended handover remains
required before replacing old Buzz.

Implemented with isolated filesystem/credential/subprocess fixtures:

- Bounded, versioned, profile-locked settings with atomic replacement, previous
  revision backup, stale-save refusal, immutable exact agent/community IDs.
- Explicit chosen-source import preview; source drift and malformed config refusal;
  the source enum binds the library directory and selected credential service
  (`buzz-desktop` installed / `buzz-desktop-dev` development), with no fallback;
  linked prompt/model/provider, runtime and environment resolution; native-only
  opaque preservation; disabled import and create-only verified credential custody.
- Write-only environment patch semantics and explicit public DTO projection.
  Explicit model/provider environment overrides win over typed selectors; a blank
  selector does not erase an override. ACP receives the same effective model.
- Idempotent start, save-versus-running revision, explicit restart, durable disabled
  Stop, enabled restore, exit/failure state, and teardown of separate process groups
  inside the listener's isolated Unix session.
- Native attestation verification before spawn (unrestricted NIP-OA only); no parent
  managed-agent identity/replay/marker/provider credential inheritance.
- Isolated macOS credential adapter: selected legacy service's `secrets` account,
  strict bounded map parsing and exact agent-key validation; separate destination
  service `dev.local.buzz.foundation.agents`, account `agent:<exact-key/community-id>`.
  Destination adds are create-only; import reads back the resulting key. Missing,
  denied and malformed credentials are distinct fixed errors, never source fallback.
  Unit tests use an injected backend and compile out all live Keychain calls.

## Known incomplete boundaries — do not claim live readiness

- Normal native startup enables Start/Restart when the app's manifest-verified
  runtime resources are staged. Credential import/create is macOS-only. Real
  Keychain consent, signing/ACL behavior and packaged custody remain unverified; other credential platforms
  report unavailable rather than storing agent keys in files.
- `scripts/build-agent-runtime.mjs` stages the immutable tools and hash manifest;
  native startup and spawn validate them without an old-bundle/PATH fallback.
  Synthetic bundled tests are separate opt-in checks, not evidence of a signed
  package or live inference.
- Cooperating new-app profiles hold an exact-key/canonical-community OS lock in
  addition to the profile lock. Native refuses detected legacy owners, but old
  Buzz does not honor these locks and can be relaunched later. Before a live Start,
  agree on handover and stop old Buzz AND its listeners; there is no coexistence
  guarantee.
- The Unix-session cleanup handles ACP's ordinary new process groups. A descendant
  that explicitly starts another session can escape this containment. Host crash
  recovery and such detached tools require further ownership work. Windows is not
  supported by this process adapter. The fixture uses macOS `/usr/bin/python3`.
- Status is process-alive, **not relay readiness, accepted mention, working or idle**.
  Worker wake and idle sleep are configured on ACP; no live ACP test has run here.
- Owner-less legacy agents, conditional attestations, remote deployment,
  relay mesh and unrecognized legacy catalog harnesses fail closed. Local team
  imports snapshot deployment-team instructions; older imports require explicit
  team repair through the chosen source library before Start. Custom harness
  definitions can be imported but provider mappings outside buzz-agent/goose require
  explicit environment configuration. Compiled-in legacy provider defaults cannot
  be recovered from JSON. Existing instance runtime wins over linked runtime,
  matching `readiness.rs`'s actual `try_record_agent_command` call (old `b9392d9`).
- Import currently snapshots definitions per exact keyed instance, not editable
  shared definition relationships. Unknown fields are retained, not all executed.
- Environment overrides are stored in mode-0600 local config, not in the OS
  credential store. Secret agent keys never intentionally enter that config.
- Default MCP/provider behavior, ACP argument normalization, execution policy and
  workspace preservation need a real compatibility acceptance pass.
- Child stdout/stderr are discarded; user diagnostics are fixed host messages.
  A safe live readiness/diagnostic adapter is still needed.

Tests are engineering evidence only. Test-only keys are public secp256k1 vectors;
no live credential storage, current agent restart, old-library mutation, relay
publication or enrollment is performed. Do not run this against real data yet.
