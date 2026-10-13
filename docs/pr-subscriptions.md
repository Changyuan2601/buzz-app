# Native PR subscriptions

Desktop agents can call `subscribe_pr({ repo, pr })` from an owning channel thread. The bound tool supplies the agent, owner, channel and root; callers cannot override them or supply a producer command. The native host verifies the saved agent, its hosting claim, the signed thread root and channel membership before polling.

The callback is an ordinary signed channel reply naming the owning agent. Agents and the Codex runtime retain responsibility for starting or steering that conversation. The subscription does not create an attention watch/timer or certify execution, model consumption, task completion or `waiting_external`.

## Requirements

The host needs the existing dedicated Monitor credential under service `buzz-persistent-monitor`, account `poster`, and the checkpoint producer at `~/.agents/skills/monitor-pr/scripts/pr-monitor-poll.py`. Credentials stay in native custody and never reach the model, producer environment or subscription files. There is no environment-key or target-agent-key fallback. Native owner authorization binds the sender to the subscription's owner. If needed, native adds the sender to the channel as a bot and confirms membership before starting the source.

The checkpoint producer accepts one JSON request on stdin with `repo`, `pr` and the previous `snapshot` (or null), plus a `refresh_roster` flag for worker startup. Its JSON response contains the next opaque `snapshot`, actionable `output` and a `terminal` boolean. The host atomically commits the snapshot and output together. The installed monitor-pr checkpoint interface reuses the existing shell producer's filtering and event policy; the first poll records a quiet baseline, and resumed polls compare against retained state. The organization roster is retained between polls and refreshed at worker startup. Ordinary shell-monitor behavior remains available.

Unsupported transport, missing producer, wrong ownership or an unconfirmed invitation fails startup. A source/transport outage retains its prior checkpoint and delivery journal. The tool returns a subscription ID, status, sender public key and baseline fingerprint, without exposing suppressed comment bodies.

## Persistence and routing

State lives in `pr-subscriptions/` beside native agent identities. Each registration binds the canonical relay, owner, agent, channel, thread root, repository and PR. Its file lock prevents another worker for the same registration in that storage scope. The existing native agent-hosting claim controls restart and polling lifetime. Ending a requesting model turn does not end its subscription.

The journal commits signed callback identities before any send. Each callback also carries a stable source identity. After an uncertain send, the host verifies that exact event's author, content, route and signature through authenticated readback. It never replaces or blindly resends the uncertain event. Pending callbacks survive restart and unavailable transport. Terminal sources stop after pending delivery is reconciled. Callback receipts prove relay delivery only; they do not prove scheduler admission or agent execution.

Existing legacy monitor directories are retained unchanged. A replacement starts with a fresh, quiet source baseline. It does not replay ambiguous legacy output, clear old pending files or infer historical receipts. Known historical receipts remain available for separate native read-only reconciliation.

## Validation boundary

The retained launcher regression failed with `No tool subscribe_pr` before this change. Tests cover bound routing, rejected overrides, unavailable native transport, exclusive registration locks, restart with retained cursor/pending attempts, duplicate source callbacks, exact receipt reconciliation without resend and wrong-route rejection. The source-process integration starts a real subprocess and routes its new event through native signing and the durable journal with a fixture transport. The monitor-pr integration exercises the existing shell policy with a controlled GitHub CLI.

These fixtures do not establish production Keychain access, production callback acceptance or five restored subscriptions. The installed native app must expose this capability before live restoration. Source changes, observer publication and fixture success alone do not deploy it. App installation/restart, PR readiness and merge require their separate authorization.
