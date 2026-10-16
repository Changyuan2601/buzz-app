# Buzz Concierge onboarding trial

Branch: `codex/buzz-concierge-onboarding`, based on the tested Mesh trigger fixes
at `a5665470`. Concierge begins as a tool-free Chat agent on the existing
MeshLLM shared-compute Provider. It offers two explicit inline paths: name and
connect this same agent, or
create a separate named assistant and receive its welcome in a private DM.
The Provider's current model supplies onboarding; Qwen is not hardcoded.

## Conversation guide

The editable script is
[`BUZZ_CONCIERGE.md`](../src/bundled/mesh-compute/BUZZ_CONCIERGE.md).
The welcome card offers **Use this agent** and **Create a new agent**, then a
labelled name field. Both paths show the registered AI buttons and reuse the
existing account/model/workspace setup dialogs. For the first successful Solo/DM
reply, the runtime guarantees the opening card even if the shared model replies
with prose or an unusable action block. It preserves prior action cards; failed
or potentially truncated history reads cannot restart the setup by guessing.

The guide asks one short question at a time:

1. Choose a path and name. For **Use this agent**, a bounded rename proposal
   shows **Use this name**;
   approval uses the existing Agents service to rename and publish its profile.
2. Choose a supported AI using the buttons directly below the saved name.
   The app lists registered choices immediately; there is no need to guess a name
   or type a harness ID. Selecting Claude or Codex opens its existing setup dialog.
   Successful Done/Continue saves its model defaults and connects this same agent,
   returning to the main chat. For **Create a new agent**, completion instead
   creates a separate assistant. Cancel/Close returns without changing identities.
   Goose uses
   its existing inline provider/model controls before Connect. The runtime supplies
   only registered local choices and the current saved agent name. Codex, Claude and
   Goose are offered when registered; Pi/Phi are not invented as supported options.
   Shared Compute can remain explicitly as a tool-free fallback.
3. Start with a general assistant role and customize it after connection.
   Role questions must not delay opening the chosen AI's setup. A tailored
   conversational proposal remains available if explicitly requested.
4. Send a first test in the same conversation. The same named agent now answers
   using the selected harness. A saved configuration is not proof of inference.

Detours and setup failures should receive a short practical answer, then return
to the next unfinished step. Reuse previous answers; do not restart completed
steps, silently substitute harnesses, or claim unconfirmed success.

A `buzz-agent` block proposes `start`, `rename` or `connect`, never executable
commands. Only the explicit new-agent UI path creates another identity. An inline
action applies the bounded edit. Agents.save
owns renaming; Agents.retype owns changing the harness, refuses mid-turn changes,
and rolls back a failed configuration write. The name, key, attention, channel
membership and selected Solo assistant are preserved. No new channel access is
needed. Connecting explicitly to Shared Compute replaces the onboarding guide
with the chosen Chat role on the same identity.

The existing viewer-scoped view receipts retain the reviewed before/after pair
before writes. Reload/retry can confirm a completed mutation without repeating it;
an older attempt cannot overwrite subsequent settings edits. A storage failure
before the receipt is saved blocks mutation. Conversation changes stop further
progress writes. Historical unbounded child-creation blocks remain inert.

## New-agent welcome DM

The new-agent path retains Concierge as the shared-compute guide. It creates the
chosen local agent with its reviewed configuration, confirms that configuration,
refreshes `session.agentChoices`, and uses the normal Direct Messages service to
open the exact owner/agent DM. It grants no access to the onboarding conversation.
The Agents service checks the live owner and exact two-member, writable DM before
using the existing native signing/publishing API. The fixed greeting is from the
new agent's identity: “Hi, I'm [name]. Your agent is set up. What would you like
help with first?” **Open DM** takes the user there for a real inference test.
In that exact owner/agent DM, a normal message wakes the local agent without an
@mention and ordinary responses stay at the top level. Group DMs and channels
retain their existing rules.

A durable receipt is saved before creation and before sending. An uncertain
identity creation pauses for recovery in Agents instead of creating another.
After an uncertain send, retry queries for the original author/channel/marker;
it never blindly republishes. Unconfirmed delivery stays incomplete with Open DM
available once the conversation exists. The greeting confirms setup, not model
inference. Config persistence, DM creation and welcome failures remain visible.

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
2. Choose **Use this agent**, enter a name and choose **Use this name**. Verify the composer
   and subsequent messages use the saved name.
3. Choose an AI button beneath the saved name. Complete the opened setup,
   reviewing account/model/workspace access and handling sign-in yourself. Choose
   Done/Continue to connect and return to this same chat; Cancel must not switch.
4. Send the proposed first test without a mention. Verify the same named agent
   answers in the main conversation, with no second agent or subthread.
5. Reopen onboarding and verify it preserves the selected harness and role.
6. In a fresh Concierge trial, choose **Create a new agent**, name it and choose
   Shared Compute. Create it. Concierge should stay unchanged, the new assistant
   should greet you in its own DM, and **Open DM** should open that conversation.
   Send a short greeting to prove actual inference. Reopening the same card and
   retrying must not create another identity or send duplicate welcome messages.

Focused checks exercise bounded parsing, explicit approval, same-key mutation,
provider blocking/recovery, stale edits, storage failures, concurrent clicks,
source/membership validation, entry reuse and actual AgentsService retype rollback.
New creation checks cover configuration persistence before admission, unknown
identity outcomes, DM retry, query-only welcome recovery, and context changes.
The welcome boundary rejects foreign or extra participants and archived DMs. No browser journeys were added or removed.
Native host signing, account inference, new signup and human acceptance must be
reported separately from component/service checks.
