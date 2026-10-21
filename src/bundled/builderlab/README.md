# Builderlab

Create agents that Builderlab hosts for you, so they keep working even when Buzz is closed.

## Getting started

1. Go to **Settings → Plugins → Builderlab agents** and choose **Sign in with Builderlab**.
2. In **Agents**, choose **New agent** and pick **Builderlab (hosted)** as the **Harness**.
3. Use the agent's **Instructions** tab to tell it what to do.

---

# Builderlab

The bundled `block.builderlab` plugin adds Settings → Plugins → Builderlab agents.
In a build with a NIP-FI identity configuration, it also registers
`block.builderlab/builderlab` in Agents' new-agent type picker.
`adapter-type/` connects this hosted type to Beekeeper: provision registers the
agent, activation submits the owner proof and community supplied by Agents, and
removal deletes the provider runtime. Agents owns unfinished setup recovery and
the runtime-tagged community registration; the provider keeps the key and runs
the agent even while Buzz is closed. On desktop, Create agent and confirmed
deletion start browser sign-in when needed, then continue the action. Both share
an existing Settings sign-in attempt; a failed or canceled login leaves the
action available for retry. Settings still provides sign-in and sign-out.
Canceling an action's wait does not cancel a shared login; disabling the plugin
or closing Buzz cancels it.
Beekeeper accepts an owner proof only from the Buzz key bound to the signed-in
Builderlab account. After sign-in, and again before each activation, the plugin
checks `/v1/buzz/nostr-identities/current` and binds an unbound account to this
device's key through the native kind 24243 signer, which accepts only
production Builderlab or this build's validated NIP-FI identity origin. An account
bound to another key is reported and never unbound.
The agent's Identity tab reads its current instructions from Builderlab and
saves changes directly to the provider. Loading and saving use the same login;
failed saves keep the draft, and switching accounts requires the original
account before saving. Empty instructions can be saved to clear them.
Settings shows the fixed remote workspace and per-thread session behavior. Both
tabs link to the configured Builderlab site for remote runtime management.
Activity shows the turns the agent published to its owner while Buzz has been
open, for the conversation it was opened from or all of them. It needs the Agent
Activity plugin, which owns the feed.
Profile updates remain TODO and report an unsupported-operation error.

The adapter retains the provider agent ID, identity origin, account email and
provisioning replay reference in `buzz.builderlab.adapter-identity.v1:` records.
No credentials or owner proofs are saved. These records survive restart and
deletion so retries can confirm an already-missing runtime without assuming
absence from another account's list. Registration retains its replay UUID until
Agents has saved unfinished setup and begins activation, or provider deletion
is confirmed. On another device, removal resolves the ID from the signed-in
account's list; an unknown key is refused. Existing Settings-created
agents are not migrated into this type.

- `session.ts` projects the shared native NIP-FI session (`federatedIdentity`).
  The native side holds the session token in OS secure storage and adds it as
  `Authorization: Bearer` only to this plugin's granted Beekeeper and
  nostr-identity routes; the renderer never sees it. A 401 from those routes
  refuses that call only. The native session decides when it has ended.
  `credential()` names the signed-in account for one session revision, with
  its email as the subject that scopes saved agents.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login, with
  refresh and retry. Settings directs people to the **Agents** tab to create,
  edit instructions and delete agents. Listing does not activate agents or
  publish community registrations. Sign-out and navigation discard late results.
  The client also supplies the hosted adapter's Beekeeper operations. Pending
  registration UUIDs survive restart, scoped to identity origin, account and
  name. Retry the same name after an uncertain failure within the server's
  seven-day replay window. Instructions are limited to 20,000 characters,
  affect newly accepted tasks and are never published to the relay.

Each sign-in reads `capabilities.can_use_remote_agents` from `GET /v1/auth/me`.
While it loads, the Agents provider shows checking and creation waits. Only
`true` makes remote agents ready; `false` shows “Coming soon”, and a failed read
offers Retry. A typed `*_FEATURE_DISABLED` status from listing or creation also
shows “Coming soon” (a 403 does too, as a fallback). No further Beekeeper
requests are sent for that sign-in.
