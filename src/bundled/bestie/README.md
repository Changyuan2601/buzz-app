# Main agent

Your main agent is pinned below Inbox in the left navigation and selected by default
in new Solo chats. The pinned destination opens your continuing private DM.

## Getting started

Open **Agents** to see the **Main agent** accent pill beneath the selected agent’s name.
Use another agent’s right-click or **… → Make main agent** action to change it, or
**Change main agent…** on the current one. The label moves; cards keep their order.
There is no independent removal action. Changing the selection does not delete
agents, move drafts between conversations, or stop work already running.

---

## Selection and compatibility

The saved default remains device-local for each account and community. With no
saved choice, main’s existing policy saves the first managed agent, then the first
selectable agent, after discovery settles. A stopped or signed-out runtime does
not replace it. Onboarding’s explicit assignment will use this same preference;
this change does not add onboarding or remote provisioning.

The destination is built in, not an optional plugin. Its legacy `buzz.bestie/bestie`
key is retained for existing navigation. Old experimental enable/disable flags are
ignored, without rewriting the saved main agent. Visible copy and artwork no
longer present a separate Bestie role.

The pinned DM uses the exact verified one-to-one roster, shared thread reader,
drafts and unread state. It is promoted out of the ordinary DM inventory while
shown at the pinned destination. Choosing another agent returns the prior DM to
Messages. Choices use `session.agentChoices.selectable`, including hosted,
library-only and other-device agents; local custody is not required. Known-archived
agents remain excluded. A saved library-only choice opens its DM without an import.
The identity, library entry and main role do not prove the agent is running or
that its harness answers untagged DMs; opening and sending retain ordinary relay
membership checks.

“Ask about this” object actions, onboarding integration and hosted provisioning
remain separate workstreams. Account sync is owned by Morgan’s
[#1665](https://github.com/block/buzz-app/pull/1665); see the landing notes below.

## Landing after account sync

This checkout still uses device-local selection. Land #1665 first, then rebase
this change onto the merged result. Do not copy its persistence, compare-and-set,
recency or deletion policy into this feature, and do not change `managed` to mean
hosted. The pinned page, sidebar, Agents actions and Solo drafts must share the
selection owner in `features/solo/default-agent.ts`.

Consumer reconciliation against #1665 (`61007ad75`, subject to its final API):

- Replace the page and Agents action’s local setter with the session-aware
  `chooseDefaultAgent(session, scope, pubkey)`. Await/catch its account-save failure;
  only the latest choice in the same session may report its error.
- Gate the sidebar, page and card designation on the owner’s account-adopted
  selection, never an ungated device cache or a temporary Solo stand-in. A failed
  account read must retain the owner’s documented offline behavior.
- Keep confirmation for replacing a different identity, but expose retry for the
  same identity after a failed account save. A role badge is not a save receipt;
  do not suppress the retry merely because the local choice already matches.
- Keep `readDefaultAgent` only as a local-cache accessor where needed; it must not
  become a second account-read or write policy. Preserve Morgan’s deletion cleanup
  and automatic selection unchanged.

Before landing, exercise the combined tree with a held account read and stale
local cache, a newer explicit choice during adoption, account-write failure/retry,
selection of a hosted/library-only agent on another install, deletion and reconnect.
The current device-local tests are not evidence for these account-sync behaviors.
A three-tree preview against `61007ad75`, including this checkout’s uncommitted
changes, finds textual reconciliation in `docs/solo/README.md`,
`AgentsPage.tsx`, `AgentsPage.test.tsx` and `default-agent.ts`. The page and sidebar
consumer changes above are also required even where Git would merge automatically.
No rebase or PR-base change has been made yet.
