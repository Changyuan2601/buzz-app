# Native PR subscriptions

Proposed direction, revised October 13, 2026 after the owning-conversation clarification. This document describes a repair contract, not implemented behavior. The initial self-signed internal callback proposal is retained in commit 37b129a6 and superseded here.

Buzz's bound MCP dispatcher currently has no PR subscription tool. The legacy persistent-monitor adapter obtains a separate signing credential and invokes the Buzz CLI. Neither operation is available to the managed plugin agent. A producer started through that adapter cannot establish supported callback delivery.

## Boundary

Add `subscribe_pr({ repo, pr })` to the existing bound Buzz MCP client. The active turn supplies the agent handle and exact channel/thread root. Model arguments cannot supply or override agent, owner, relay, channel, root, executable, credentials, or callback destination. Standalone MCP clients and browser clients without the native capability report unavailable before starting any producer.

Native `AppAgentHost` owns subscription lifetime, persistence, signing, and authenticated ownership. Resolve the saved agent and owner, verify the owning app's agent hosting claim, and read the exact root and channel membership as that agent before registering. Bind the registration to the canonical relay, owner, agent, channel, root, repository and PR. Reject mismatches rather than correcting or falling back to another conversation.

Reuse the existing authenticated relay-event → Agents scheduler → Codex conversation path. The host signs callbacks as a native-managed dedicated sender attested to the same owner, with the exact channel/root and owning agent recipient. Validate sender custody, attestation and channel membership before producer startup. Native custody must be supported by the app; the calling agent never reads credentials, invokes the Buzz CLI, or starts a second agent runtime. If that native sender capability is unavailable, fail startup explicitly with retained state.

Do not add a direct internal callback trigger, a self-message exception, a second conversation scheduler, or a separate app-server client. Current main already routes authenticated sibling messages and owns the per-agent hosting claim. Codex continues the saved conversation through thread/resume and turn/start when idle, or turn/steer when active. Validate the existing session-scope setting: thread is the default; channel scope intentionally shares a session while keeping the reply root. Do not silently change that preference.

Saved event watches and timers remain attention responsibilities. PR polling produces external source events; command-output subscriptions buffer producer output. Neither needs to enable attention, create a saved watch/timer, or introduce one-off attention sessions. Codex explicitly rejects timer triggers and does not yet implement Claude's one-off Interest turns, but it already accepts authenticated event callbacks without a human turn.

## Durable delivery

Keep one native worker per exact target and PR, protected by the existing per-agent hosting claim plus a subscription lock. Repeated start returns the same registration. App restart reloads that registration only when the app owns the agent. Ending the requesting model turn does not stop its subscription; releasing the agent's hosting claim does.

Persist a versioned baseline, source cursor and immutable callback ID before delivery. The polling implementation must checkpoint its actual source snapshot, not reconstruct it from displayed stdout or overwrite it with a restart's initial summary. A fresh subscription records a quiet baseline; events after that cut become callbacks. A resumed subscription compares against its retained baseline so changes during downtime remain observable.

The journal distinguishes unsent callbacks, signed delivery attempts and verified relay receipts. Save the signed event identity before sending; duplicate source events retain that identity. Transport unavailability retains pending callbacks. An uncertain send selects exact receipt verification, never a fresh event or blind resend. Receipt acceptance means relay delivery, not scheduler admission, model execution, model consumption, semantic task completion or an external-wait certificate. The existing scheduler's overload behavior and volatile seen IDs need explicit integration coverage; relay acceptance alone cannot certify callback admission. Keep receipt evidence separate from the execution-observer repair.

Retain legacy registrations and pending files unchanged. Known relay receipts may be verified through native authenticated reads against exact author, channel/root, recipients and content. Unknown event identity remains quarantined and is never resent. Import verified historical receipts as historical records only. Start the new source with an explicit baseline; do not transform ambiguous legacy output into new callbacks.

## Scope and validation

Reuse the monitor-pr producer's event policy and author filtering. Its current shell implementation keeps source snapshots in temporary files and does not expose a durable resume contract. Before integrating it, add a bounded snapshot/checkpoint interface or an equivalent finite polling interface under that producer's owner. A launcher that merely captures stdout does not satisfy restart safety. Do not copy a second mutable event policy into Buzz.

Expected production owners are the Buzz MCP client/tool dispatcher, native agent host/signing transport, and one PR source/outbox bridge. Reuse the existing process host, hosting claim and scheduler; do not add a conversation wake owner. Target roughly 500–700 new production lines, excluding tests/docs and any producer change. Reassess that budget before adding a second lifetime owner, alternate transport, or a new producer implementation.

The first regression test traverses `respond` → `callTool` → `appClient` and expects `app_agent_subscribe_pr` with native-owned agent/owner and the bound route. On main `88575c007a7f423cf605318acc10d5a58753b896`, it fails with `No tool subscribe_pr` and no native invocation. The Tauri transport is mocked; this establishes the missing launcher boundary, not native startup or callback acceptance.

Remaining integration cases must cover simultaneous repeated registration; restart with a retained source cursor and pending callback; native transport unavailable before launch and during delivery; wrong agent/channel/root/repository/PR; duplicate callbacks; a receipt-only reconciliation; and ambiguous history without a receipt. Exercise actual native worker startup and a new source event through the real scheduler with a disposable identity and controlled source. PR polling and callback receipts must never emit plugin-observer execution evidence or authorize `waiting_external`.

A deployed native app build is required to expose this capability to the running managed agent. A source change or fixture pass alone cannot restore the five real subscriptions. Mac app installation/restart, PR readiness and merge remain separately authorized actions. Preserve the observer worktree and all unrelated PR worktrees throughout this repair.

## Current-main evidence

Inspected main 53970a71f195df6201ef9983574515d621f77cbc: [addressed relay delivery](https://github.com/block/buzz-app/blob/53970a71f195df6201ef9983574515d621f77cbc/src/features/agents/service.ts#L1855), [Codex event handling and timer rejection](https://github.com/block/buzz-app/blob/53970a71f195df6201ef9983574515d621f77cbc/src/bundled/codex/runtime.ts#L337), [active steering](https://github.com/block/buzz-app/blob/53970a71f195df6201ef9983574515d621f77cbc/src/bundled/codex/runtime.ts#L416), and [saved-thread resume/start](https://github.com/block/buzz-app/blob/53970a71f195df6201ef9983574515d621f77cbc/src/bundled/codex/runtime.ts#L810).

[Official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server) documents resume, start and steer. The installed persistent-monitor Codex adapter uses Desktop follower IPC and an experimental thread/queue/add fallback. Local Codex 0.162.1 exposes that queue method in its generated experimental schema. This confirms protocol presence, not live IPC or queue acceptance; Buzz must retain ownership of its own app-server and conversation bindings.
