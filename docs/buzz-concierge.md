# Buzz Concierge onboarding trial

Branch: `codex/buzz-concierge-onboarding`, based on the tested Mesh trigger fixes
at `a5665470`. This is a first-agent conversation in the existing Consumer, with
inference served by the existing shared-compute Provider.

## Conversation guide

The editable guide is
[`BUZZ_CONCIERGE.md`](../src/bundled/mesh-compute/BUZZ_CONCIERGE.md).
It is loaded verbatim by the Buzz Concierge helper preset. It asks one question
at a time: what should the agent do, what should a good answer look like, and
what should it be called? It then proposes instructions and a first test.

Concierge is a Mesh **Chat** agent. It has no shell, file or Buzz tools.
Its proposal is bounded JSON in a `buzz-agent` fenced block. The Mesh plugin
renders that proposal as a review with a **Create agent** button. Nothing is
created by rendering the message or by telling Concierge “yes.”

The button uses the existing Agents service to create a Mesh Chat agent owned
by the viewer, then the existing signed membership operation to add it to the
same channel. The review states that this grants conversation access. A saved
source-message ID lets membership retries reuse the created agent. Concierge
saves an attempt marker in its own settings before identity creation, and checks
the actual saved Chat settings before granting channel access. Current
community, ownership, channel participation and Concierge identity are checked
at activation and again before continuing after asynchronous work. Only local
agents with the Concierge preset can supply these reviews; a matching name or
JSON from another member is insufficient.

First agents are mention-driven, tool-free and scoped per thread. Automatic
watches, scheduling, Agent-mode tools and other inference providers are outside
this trial. A goal requiring those capabilities should be reduced to a useful
conversation-only first step before the draft is proposed.

## Native test setup

1. Keep the existing Provider sharing in the MeshLLM community. In Consumer,
   select the same community and create a private `onboarding` stream channel.
2. In Shared compute → Helpers, create **Buzz Concierge**. Add it to
   `onboarding` using the channel's member picker.
3. In Concierge's Attention settings, add an Interest for first-agent onboarding
   and an enabled event watch restricted to the onboarding channel and the
   owner's exact public key. This permits natural follow-ups without mentioning
   Concierge on every turn. Set sessions to **One session per channel**. Do not
   watch other channels or other agents' replies.
4. Post “Hi, help me create my first agent.” Answer Concierge's questions.
   Ask for a simple brainstorming or summarizing helper to start.
5. Review the proposed name and instructions. Choose **Create agent**. Confirm
   it reports that the agent is ready, then mention the new agent in this
   channel with the proposed test. Judge its actual reply before refining it.
   Creation switches Concierge's Attention off so it does not answer the new
   agent's test as well. Mention Buzz Concierge explicitly for more help.

## Checks and recovery

- Read an unrelated channel: Concierge should remain quiet.
- Ask for changed instructions before creation: it should produce a revised
  review, without claiming the earlier draft was already created.
- A provider outage should show the existing inference error. No alternate
  provider is selected by the onboarding feature.
- A membership failure leaves the created agent available in Agents and offers
  **Continue setup**. Retry there; do not create another copy manually.
- A context change during creation stops subsequent channel writes. Reopen the
  proposal in its original community to continue.
- If the app restarts after identity creation but before its settings were saved,
  the unresolved attempt pauses new creation. Recover the partly created agent
  through Agents; automatic reconciliation of that failure is outside this trial.
- Browser-only tests cover proposal validation and UI/service ordering. The
  native test above is needed for Keychain identity, signed membership and real
  shared inference. Human acceptance of the new flow remains a separate check.
