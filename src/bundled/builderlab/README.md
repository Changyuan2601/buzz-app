# Builderlab

Create agents that Builderlab hosts for you, so they keep working even when Buzz is closed.

## Getting started

1. Go to **Settings → Plugins → Builderlab agents** and choose **Sign in with Builderlab**.
2. In **Agents**, choose **New agent** and pick **Builderlab (hosted)** as the **Harness**.
3. Choose a model and reasoning effort, optionally add instructions, then create the agent.
4. Edit instructions later in **Identity**, and model settings in **Settings**.

---

# Builderlab

## Apps pilot

Local agents can create, deploy, inspect readiness, share and open Apps Platform
apps using the Settings Builderlab sign-in. `apps_contract` reports the selected
tenant's runtimes and schema location. Creation checks that contract and supports
`static` and `fetch-js`; it repeats the selected runtime through reservation and
initialization. The executable profile returns the required asset manifest and
bindings, even when its handler serves all content itself.

BBBlock is the employee pilot. BBPublic uses the same authenticated control-plane
boundary: the server must grant Builderlab access to the current workspace/account.
Existing workspace early-preview enablement can provide that access; these tools
do not enable a workspace or bypass its policy. A denied request preserves the
server's permission error. Check the contract before choosing a profile because
BBPublic need not support static hosting.

After an accepted deployment, readiness errors preserve its app, version,
deployment and rollout IDs. `apps_status` checks those exact IDs without uploading
again. A failed reservation or initialization names the planned app ID; inspect or
resume that app before creating another one. Automatic reservation recovery and
hosted tool declarations are separate work.

The app panel uses the existing native browser and persistent website store on
macOS 14+. Website login is separate from Settings login, including sign-out and
account switching. Confirm the website account when testing. Earlier macOS uses a
private store; other platforms do not expose the embedded app panel. CLI-to-site
SSO is a separate integration.

## Remote agents

The bundled `block.builderlab` plugin adds Settings → Plugins → Builderlab agents.
With a valid `BUZZ_BUILDERLAB_URL` build input, it also registers
`block.builderlab/builderlab` in Agents' new-agent type picker.
`adapter-type/` connects this hosted type to Beekeeper: provision registers the
agent, activation submits the owner proof and community supplied by Agents, and
removal deletes the provider runtime. Agents owns unfinished setup recovery and
the runtime-tagged community registration; the provider keeps the key and runs
the agent even while Buzz is closed. On desktop, Create agent and confirmed
deletion start browser sign-in when needed, then continue the action. Both share
an existing Settings sign-in attempt; a failed or canceled login leaves the
action available for retry. Settings still provides sign-in and sign-out.
While Create agent waits for the browser, its dialog offers Cancel sign-in, which
cancels the shared login (as Settings' does) and leaves Create available for
retry. Deletion's wait has no such control; disabling the plugin or closing Buzz
also cancels it.
Beekeeper accepts an owner proof only from the Buzz key bound to the signed-in
Builderlab account. After sign-in, and again before each activation, the plugin
checks `/v1/buzz/nostr-identities/current` and binds an unbound account to this
device's key through the native kind 24243 signer, which accepts only
production Builderlab or this build's `BUZZ_BUILDERLAB_URL` origin. An account
bound to another key is reported and never unbound.
The agent's Identity tab reads its current instructions from Builderlab and
saves changes directly to the provider. Loading and saving use the same login;
failed saves keep the draft, and switching accounts requires the original
account before saving. Empty instructions can be saved to clear them.
The Settings tab loads a separate model catalog from Builderlab. Choose a model
and one of that model's reasoning efforts, then save the pair for new tasks.
There is no default or fallback selection. Missing or unavailable saved choices
show the server's setup status and require a supported pair. Changing the model
clears the effort choice. Instructions and model settings save independently.
Creation offers the same catalog choices and optional instructions. The provider
registers and activates the agent before saving the settings together. Unfinished
setup retains these values on this device so retry continues the same agent,
including after a restart. Setup completes only once the settings save succeeds.
Settings shows the fixed remote workspace and per-thread session behavior. Both
tabs link to the configured Builderlab site for remote runtime management.
Activity shows the turns the agent published to its owner while Buzz has been
open, for the conversation it was opened from or all of them. It needs the Agent
Activity plugin, which owns the feed.
Create sends the chosen picture with registration, and Beekeeper publishes it at
attestation. Renaming or changing the picture republishes the agent's profile
through Beekeeper's `update-agent-profile`.

The adapter retains the provider agent ID, server, verified account subject and
provisioning replay reference in `buzz.builderlab.adapter-identity.v1:` records.
These hold no credentials or owner proofs; the sign-in itself lives only in the
OS credential store (see [Staying signed in](#staying-signed-in)). They survive restart and
deletion so retries can confirm an already-missing runtime without assuming
absence from another account's list. Registration retains its replay UUID until
Agents has saved unfinished setup and begins activation, or provider deletion
is confirmed. On another device, removal resolves the ID from the signed-in
account's list; an unknown key is refused. Existing Settings-created
agents are not migrated into this type.

- `oauth/` owns browser handoff, code exchange, account verification, and the
  plugin-lifetime session. `browserCredential()` returns a verified `Credential`;
  `session.credential()` provides access to it. The session handles cancellation,
  sign-out, disposal, and the saved sign-in described below; `store.ts` is its
  only path to the OS credential store.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login, with
  refresh and retry. Settings directs people to the **Agents** tab to create,
  edit instructions and delete agents. Listing does not activate agents or
  publish community registrations. Requests reuse the OAuth credential through
  native host HTTP; sign-out and navigation discard late results.
  The client also supplies the hosted adapter's Beekeeper operations. Pending
  registration UUIDs survive restart, scoped to server, verified account and
  name. Retry the same name after an uncertain failure within the server's
  seven-day replay window. Instructions are limited to 20,000 characters,
  affect newly accepted tasks and are never published to the relay.
- `known-communities/` keeps the account's community list in step with this
  device through the `knownCommunities` capability while signed in, in native
  builds with a configured service. The list is an account-scoped set behind
  three idempotent JSON routes under `/v1/buzz/known-communities/`: `list`
  (`{}` → `{ communities: [{ community_url }] }`), `add` and `remove` (each
  `{ community_url }`; adding a saved destination or removing an absent one
  succeeds, and adds past about 1,000 saved destinations are refused with
  `limit_reached`). Each sign-in merges the complete list (adding what it
  lists; a saved membership it omits is kept and not uploaded again, since
  removals made on another device are ignored for now), then sends each
  destination's latest queued join or leave one at a time, retrying failures
  as sent. A list this client cannot read halts sync until the next sign-in,
  as does a 404 on any route (not yet deployed); a listed address the device
  could never save is dropped and counted, never a halt. See
  [communities](../../../docs/communities.md#known-communities).

The plugin uses the `BUZZ_BUILDERLAB_URL` [build input](../../../docs/configuration.md#builderlab-url-build-input)
as its server address and appends `/api/goose`.

On desktop, the plugin supplies `/v1/auth/login` with `type=cli` and
`product=builderlab` to the shared native
[`oauth_callback` module](../../../src-tauri/src/oauth_callback/README.md).
Native code inserts a loopback `redirect_uri` address, opens the browser, and returns
callback parameters to the plugin. Native code generates and validates OAuth
state; the plugin also uses a random callback path.

Each attempt generates a random PKCE verifier held only in memory, sending its
SHA-256 challenge with `code_challenge_method=S256` during login. The plugin
posts the callback code and `code_verifier` to `/v1/auth/login/exchange`, then
verifies the returned session credential with `/v1/auth/me` using the
`X-BB-Session-Credential` header. These requests use the shared host transport.
The login snapshot retains `capabilities.can_use_remote_agents`; only explicit
`true` enables remote agents. Otherwise, Settings and the Agents provider show
“Coming soon” and no Beekeeper requests are sent. Each launch and each sign-in
refreshes this capability.

## Staying signed in

On desktop, a sign-in outlives Buzz. After the browser sign-in is verified, the
session hands the credential and the verified account, as one JSON blob, to the
native `builderlab_session_replace` command, which keeps it in the OS credential
store (`src-tauri/src/builderlab_session.rs`): the login Keychain on macOS, the
Secret Service on Linux and Credential Manager on Windows, under service
`xyz.block.buzz.desktop.builderlab-session` (`.debug` with Rust debug assertions,
so development builds share one item apart from the installed app's), account
`builderlab`. On macOS the item is created by the Buzz binary, so only that binary
reads it without a prompt. The session credential is the whole sign-in: Builderlab
issues no refresh token, so nothing expires on a schedule the app can see.

At launch the plugin reads the item once and, if it holds a credential, signs in
at once with the saved account, so the sign-in works offline and no request
waits for the check that follows: `GET /v1/auth/me` with the saved credential.
A `401` means the server no longer accepts it; the item is deleted, the session
signs out and Settings says the sign-in expired. Any other failure to reach or
be answered by the server leaves the restored sign-in as it is. A changed account
(for example a new remote-agents capability) replaces the credential in memory,
as a new sign-in would, and rewrites the item. A blob this plugin cannot decode
is deleted and treated as no sign-in.

The item is written after every browser sign-in and after a launch check that
changed the account. It is deleted by **Sign out** in Settings, and whenever a
remote-agents or known-communities request is answered `401`, which signs the
session out (an Apps request answered `401` reports it to the agent instead).
Disabling the plugin, quitting Buzz and Buzz's own identity sign-out leave
it in place. Every store failure is logged (never with the credential) and the
session carries on in memory, as before anything was saved; a Keychain that
refuses to be read leaves the plugin signed out until the next sign-in.

The in-memory credential is the one every request reads; the store is touched
only at launch, sign-in and sign-out. To clear a saved sign-in by hand while
debugging, use **Sign out** in Settings, Keychain Access, or:

```sh
security delete-generic-password -s xyz.block.buzz.desktop.builderlab-session.debug -a builderlab
```

Drop `.debug` for a release build. The Vite dev server and other browser builds
have no store: their sign-in lasts for the page.

`builderlab_session_read` is the first native command that returns a secret to
the webview; the TypeSafe key, by comparison, is only ever set or cleared. Tauri
capabilities are scoped to a webview, not to a script within it, and installed
plugins are loaded into the `main` webview's realm with a dynamic `import(url)`
(`src/plugins/modules.ts`), so any installed plugin can invoke the command and
obtain the Builderlab credential. This is an accepted trade-off for now: the
credential is already in that realm's memory for every request the plugin makes.
Closing the gap would take a realm installed plugins cannot reach (a separate
webview or isolated plugin realm) or a native proxy that attaches the credential
to Builderlab requests without handing it over.
