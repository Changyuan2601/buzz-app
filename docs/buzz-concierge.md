# Buzz Concierge onboarding trial

Branch: `codex/buzz-concierge-onboarding`, based on the tested Mesh trigger fixes
at `a5665470`. Concierge runs on the existing shared-compute Provider. The new
agent can use a different registered local harness.

## Conversation guide

The editable guide is
[`BUZZ_CONCIERGE.md`](../src/bundled/mesh-compute/BUZZ_CONCIERGE.md).
It asks one short question at a time: the agent's job, name, harness and any
needed response style. The runtime supplies the registered local harness list;
unregistered harnesses, including Pi on this build, are not offered.

Concierge itself is tool-free Mesh Chat. A bounded `buzz-agent` JSON proposal
renders as an in-conversation review. The person can select a harness, use its
existing model and setup controls, and approve **Create agent**. Conversation
text alone cannot install software or create an agent. Codex and Claude retain
their provider-owned installation/sign-in dialogs. Goose retains its provider,
key, model and connection-test controls; account credentials never enter chat.
Claude's dialog runs Buzz's managed `claude auth login` locally and stays pending
while the person approves in their browser. A fallback code goes only in that
dialog. **Sign in again** remains available when cached credentials report ready,
and the review card keeps **Manage Claude** after creation for recovery. Sign-in
output remains visible after the process ends, including failures. Creation waits
while provider setup is running; successful creation is not proof of inference.
Shared Compute creates a tool-free Chat agent. Other local harnesses retain
their existing tool/account behavior and configuration ownership.

The existing Agents service owns identity creation and settings; the existing
session owns signed admission. The review grants access only to its conversation.
Concierge saves an attempt before creation and verifies the service's actual
persisted settings before admission. A completed receipt fingerprints the child's
settings, so retry cannot silently overwrite later edits. Only a known failed
initial settings write may be repaired, while its observed fallback is unchanged.
An uncertain identity outcome after restart pauses creation for manual recovery.

## Entry and main-chat behavior

A successful **Create a new identity** opens the first-agent welcome. Restoring,
importing or failing to read an identity does not count as signup. The intent is
saved per viewer; failed persistence stays visible with a retry and does not
create another identity. **I'll do this later** dismisses the welcome.

The prototype uses `https://meshllm.communities.buzz.xyz`. The person explicitly
connects through the normal community admission/profile flow; signup does not
silently join a relay. No arbitrary relay or inference-provider fallback is used.
Existing users can start from **Settings → Shared compute → Helpers → Start
onboarding in Solo**, with MeshLLM selected.

Starting creates a private **Welcome to Buzz** Solo conversation and adds Buzz
Concierge from the current owner's local agent library. A normal owner request
starts a real signed Concierge welcome. The selected assistant handles plain
follow-ups without repeated mentions or Attention watches. Setup operation IDs
remain in the existing view-receipt format so retries reuse the identity, channel
and initial request. Reopening a completed start returns to the same conversation.

Mesh reads the owner's existing Solo placement once for each admitted turn.
Solo uses one conversation context and posts top-level messages, with no subthread
reference. Ordinary Multiplayer replies remain threaded, and DMs retain their
existing routing. An unreadable Solo placement fails closed. Creating the first
agent selects it as the follow-up assistant and pauses Concierge's Attention.
The person can explicitly mention Concierge again for help.

## Native test and recovery

1. Leave the Provider sharing compute in MeshLLM. Open that community in Consumer.
2. Choose **Start onboarding in Solo** from Shared compute's Helpers section.
3. Verify the brief welcome appears in the main conversation. Answer with a job,
   name and registered harness. Plain follow-ups should appear in that same chat.
4. Review the instructions and harness settings. Complete any provider sign-in
   or macOS Keychain prompt yourself. Choose **Create agent**.
5. Send the proposed first test without a mention. The new selected agent should
   answer at top level. Judge its actual reply; creation alone does not prove
   provider inference or tool execution.

Also check an unrelated Multiplayer conversation still uses replies, switching
communities cancels further setup writes, unconfirmed membership offers a retry
without another identity, edited child settings are preserved, and restarting
an uncertain identity creation pauses rather than duplicating it.

Focused tests cover identity-entry intent, UI/config adoption, service persistence,
receipt recovery and routing. Native acceptance is required for Keychain custody,
community admission, signed channel membership and real shared inference. Fresh
signup against a real new account and every harness's live inference remain
separate acceptance checks unless explicitly recorded as tested. No new automatic
watches, timers, arbitrary agent creation tools or hosted-harness provisioning are
part of this trial.
