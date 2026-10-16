# Buzz Concierge onboarding trial

Branch: `codex/buzz-concierge-onboarding`, based on the tested Mesh trigger fixes
at `a5665470`. Concierge begins as a tool-free Chat agent on the existing
MeshLLM shared-compute Provider. It becomes the person's own assistant: the
same identity is named and connected to a chosen registered local harness.
No second agent is created by the onboarding conversation.

## Conversation guide

The editable script is
[`BUZZ_CONCIERGE.md`](../src/bundled/mesh-compute/BUZZ_CONCIERGE.md).
The welcome is: “Hi there! I'm your concierge agent, here to help you get started
with Buzz. First, what would you like to name me?”

The guide asks one short question at a time:

1. Choose a name for this agent. A bounded rename proposal shows **Use this name**;
   approval uses the existing Agents service to rename and publish its profile.
2. Choose a supported harness the person can access. The runtime supplies only
   registered local choices and the current saved agent name. Codex, Claude and
   Goose are offered when registered; Pi/Phi are not invented as supported options.
   Shared Compute can remain explicitly as a tool-free fallback.
3. Choose a useful role, or a general assistant if the person wants to skip.
   Review its instructions, account, model and workspace controls inline, then
   choose **Connect this agent**.
4. Send a first test in the same conversation. The same named agent now answers
   using the selected harness. A saved configuration is not proof of inference.

Detours and setup failures should receive a short practical answer, then return
to the next unfinished step. Reuse previous answers; do not restart completed
steps, silently substitute harnesses, or claim unconfirmed success.

A `buzz-agent` block proposes only `rename` or `connect`, never executable commands
or a new identity. An explicit inline action applies the bounded edit. Agents.save
owns renaming; Agents.retype owns changing the harness, refuses mid-turn changes,
and rolls back a failed configuration write. The name, key, attention, channel
membership and selected Solo assistant are preserved. No new channel access is
needed. Connecting explicitly to Shared Compute replaces the onboarding guide
with the chosen Chat role on the same identity.

The existing viewer-scoped view receipts retain the reviewed before/after pair
before writes. Reload/retry can confirm a completed mutation without repeating it;
an older attempt cannot overwrite subsequent settings edits. A storage failure
before the receipt is saved blocks mutation. Conversation changes stop further
progress writes. Historical child-creation blocks no longer offer creation.

## Accounts and recovery

Codex and Claude keep their provider-owned install/sign-in dialogs; Goose keeps
its existing provider, key, model and connection-test controls. Credentials never
belong in chat. Claude's dialog runs managed `claude auth login` locally while the
person approves in their browser. A fallback code goes only in that dialog.
**Sign in again** is available even when cached credentials report ready. A local
successful process and confirmed account state produce **Done**; successful logs
are under **Setup details**, while failure remains visible.

Connection is blocked while provider setup needs attention or is running. The
inline card retains provider management after connection. A failed retype leaves
the original shared-compute guide intact for recovery. A changed role or harness
is preserved when reopening onboarding; the entry must not reset it to Concierge.

## Entry and main-chat behavior

Successful **Create a new identity** opens the welcome. Restore/import and failed
identity reads do not count as signup. Intent is saved per viewer, and a failed
save offers retry without another identity. **I'll do this later** dismisses it.

The prototype uses `https://meshllm.communities.buzz.xyz`. The person explicitly
connects through normal community admission/profile setup. Existing users can use
**Settings → Shared compute → Helpers → Start onboarding in Solo**.

Starting creates a private **Welcome to Buzz** Solo conversation and adds the
initial Concierge from the owner's library. A normal signed owner seed starts
the real model welcome. Plain follow-ups go to the selected agent without repeat
mentions or broad Attention watches. Durable entry receipts reuse the existing
identity, channel and seed. Reopening returns to the saved conversation.

Solo reads whole-channel context and posts at top level without subthread tags.
Multiplayer retains ordinary threaded replies. No new timers, hosted provisioning,
model-operated shell tools or arbitrary agent-creation tools are introduced.

## Native trial

1. Leave Provider sharing compute in MeshLLM. Open Consumer's Solo onboarding chat.
2. Answer the welcome with a name and choose **Use this name**. Verify the composer
   and subsequent messages use the saved name.
3. Ask for a supported harness; review account/model/workspace settings. Complete
   sign-in or macOS security prompts yourself, then **Connect this agent**.
4. Send the proposed first test without a mention. Verify the same named agent
   answers in the main conversation, with no second agent or subthread.
5. Reopen onboarding and verify it preserves the selected harness and role.

Focused checks exercise bounded parsing, explicit approval, same-key mutation,
provider blocking/recovery, stale edits, storage failures, concurrent clicks,
source/membership validation, entry reuse and actual AgentsService retype rollback.
Child-creation and new-membership tests were replaced because those writes were
removed; the corresponding authorization, durability and failure contracts remain
covered at the self-edit boundary. No browser journeys were added or removed.
Native host signing, account inference, new signup and human acceptance must be
reported separately from component/service checks.
