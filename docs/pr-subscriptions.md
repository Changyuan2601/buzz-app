# Native PR subscriptions

Proposed direction, October 13, 2026. This document describes a repair contract, not implemented behavior.

Buzz's bound MCP dispatcher currently has no PR subscription tool. The legacy persistent-monitor adapter obtains a separate signing credential and invokes the Buzz CLI. Neither operation is available to the managed plugin agent. A producer started through that adapter cannot establish supported callback delivery.

## Boundary

Add `subscribe_pr({ repo, pr })` to the existing bound Buzz MCP client. The active turn supplies the agent handle and exact channel/thread root. Model arguments cannot supply or override agent, owner, relay, channel, root, executable, credentials, or callback destination. Standalone MCP clients and browser clients without the native capability report unavailable before starting any producer.

Native `AppAgentHost` owns subscription lifetime, persistence, signing, and authenticated ownership. Resolve the saved agent and owner, verify the owning app's agent hosting claim, and read the exact root and channel membership as that agent before registering. Bind the registration to the canonical relay, owner, agent, channel, root, repository and PR. Reject mismatches rather than correcting or falling back to another conversation.

Use a native callback to the app's existing agent scheduler, rather than requiring an additional relay poster profile or runtime. The host signs each callback with the subscribed agent's existing native-held key and attestation. This is an internal authenticated source, not an ordinary self-authored relay message. The scheduler admits it only from the native subscription channel after checking its registration, route and signed event identity. Ordinary self-authored messages retain their existing behavior. No key or signing input is passed to a producer.

This avoids creating, starting or moving a Monitor agent, modifying production channel membership, or depending on the failed legacy poster-profile parser. It requires a small explicit callback admission boundary in the agent scheduler, with its existing busy/rate-limit policy returning rejection rather than acknowledging dropped work.

## Durable delivery

Keep one native worker per exact target and PR, protected by the existing per-agent hosting claim plus a subscription lock. Repeated start returns the same registration. App restart reloads that registration only when the app owns the agent. Ending the requesting model turn does not stop its subscription; releasing the agent's hosting claim does.

Persist a versioned baseline, source cursor and immutable callback ID before delivery. The polling implementation must checkpoint its actual source snapshot, not reconstruct it from displayed stdout or overwrite it with a restart's initial summary. A fresh subscription records a quiet baseline; events after that cut become callbacks. A resumed subscription compares against its retained baseline so changes during downtime remain observable.

The journal distinguishes queued callbacks, delivery attempts and acknowledged callback receipts. Native callback delivery and acknowledgment use the same registration and event ID. Duplicate callbacks are idempotent at the scheduler's admission boundary. Transport unavailability or scheduler rejection retains the pending callback. Receipt acceptance means durable callback admission, not model execution, model consumption, semantic task completion or an external-wait certificate. The integration must exercise restart across the admission/acknowledgment gap, not just restart after a clean receipt.

Retain legacy registrations and pending files unchanged. Known relay receipts may be verified through native authenticated reads against exact author, channel/root, recipients and content. Unknown event identity remains quarantined and is never resent. Import verified historical receipts as historical records only. Start the new source with an explicit baseline; do not transform ambiguous legacy output into new callbacks.

## Scope and validation

Reuse the monitor-pr producer's event policy and author filtering. Its current shell implementation keeps source snapshots in temporary files and does not expose a durable resume contract. Before integrating it, add a bounded snapshot/checkpoint interface or an equivalent finite polling interface under that producer's owner. A launcher that merely captures stdout does not satisfy restart safety. Do not copy a second mutable event policy into Buzz.

Expected production owners are the Buzz MCP client/tool dispatcher, native agent host, one native PR-subscription module, and the existing agent scheduler's narrow callback admission path. Target roughly 500–700 new production lines, excluding tests/docs and any producer change. Reassess that budget before adding a second lifetime owner, alternate transport, or a new producer implementation.

The first regression test traverses `respond` → `callTool` → `appClient` and expects `app_agent_subscribe_pr` with native-owned agent/owner and the bound route. On main `88575c007a7f423cf605318acc10d5a58753b896`, it fails with `No tool subscribe_pr` and no native invocation. The Tauri transport is mocked; this establishes the missing launcher boundary, not native startup or callback acceptance.

Remaining integration cases must cover simultaneous repeated registration; restart with a retained source cursor and pending callback; native transport unavailable before launch and during delivery; wrong agent/channel/root/repository/PR; duplicate callbacks; a receipt-only reconciliation; and ambiguous history without a receipt. Exercise actual native worker startup and a new source event through the real scheduler with a disposable identity and controlled source. PR polling and callback receipts must never emit plugin-observer execution evidence or authorize `waiting_external`.

A deployed native app build is required to expose this capability to the running managed agent. A source change or fixture pass alone cannot restore the five real subscriptions. Mac app installation/restart, PR readiness and merge remain separately authorized actions. Preserve the observer worktree and all unrelated PR worktrees throughout this repair.
