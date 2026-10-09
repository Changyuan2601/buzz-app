# Builderlab

The bundled `block.builderlab` plugin adds Settings → Integrations → Builderlab.

- `oauth/` owns browser handoff, code exchange, account verification, and the
  plugin-lifetime session. `browserCredential()` returns a verified `Credential`;
  `session.credential()` provides access to it. The session handles cancellation,
  sign-out, and disposal.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login. Requests
  reuse the OAuth credential through native host HTTP; sign-out and navigation
  discard late results. Existing catalog agents are not automatically registered
  into Buzz communities.
  Creation registers a name, then attests its key using the host's existing
  owner authorization. When a community is selected, attestation includes its
  WebSocket URL to enroll with Beekeeper; Personal space omits it. An unattested
  row offers **Finish setup**; no second registration is needed. Pending
  registration UUIDs survive restart and are scoped to server, verified account
  and name. Retry the same name after an
  uncertain failure within the server's seven-day replay window. Credentials
  and owner proofs are never stored.
  With a connected community selected, activation is followed by owner-signed
  kind-30177 registration through the session's durable outbox. Completion waits
  for relay acceptance and shared agent discovery. Names use the existing shared
  naming service; picker, archive and membership policies remain in their owners.
  Pending enrollment intent is scoped to server, account, community and Buzz
  identity. Opening Settings after reconnect/restart resumes intended Active
  creations; **Retry community setup** reuses a pending publication without
  registering or attesting again. Personal space skips relay registration.
  Creation never adds channel membership.
  Optional **Agent instructions** are saved through Beekeeper's `update-agent`
  after activation and community setup. Active rows offer **Edit**
  with Save and Cancel; saving replaces the text, and an empty value clears it.
  `list-agents` requests `include_instructions: true` to populate the editor.
  Instructions affect newly accepted tasks and are never published to the relay.
  Drafts stay in memory across setup/save retries and refreshes; a failed save
  can be retried on the same agent without creating another. Navigation, restart
  or sign-out discards drafts. Text is limited to 20,000 characters.
  **Delete** confirms owner-signed kind-5 deletion of the selected
  community's registration, refreshes discovery, then deletes the runtime through
  Beekeeper. Personal space only deletes from Beekeeper. Failure leaves the row
  available for manual retry; an already-missing Beekeeper agent counts as success.
  Account-scoped deletion tombstones (`buzz.builderlab.deletion.v1:`) persist to
  fence new enrollment after restart or in another community. They contain only
  server/account scope and agent pubkey. Standard Web Locks, also used by the
  app's read-state sync, order registration and deletion
  for the same scope across app windows; deletion waits for an issued registration
  attempt to settle, even when its caller cancels. If that session retires, the
  lock drain ends without confirming or discarding its receipt; a ten-second
  bound also covers disposal without notification. Setup requires Web Locks.
  Successful deletion retires failed or confirmed registration receipts.
  Deletion does not archive identities, remove channel memberships, erase history,
  or clean registrations in other communities.

Deletion follow-ups requiring shared relay/outbox support:

- Relay acceptance alone does not prove coordinate absence: clock skew can leave
  a newer registration advertised after the runtime is deleted. A fresh strong
  relay-only read is needed; `session.read()` includes local evidence. Failed
  discovery reads currently stop backend deletion, but are not absence proof.
- Web Locks do not cover other devices or survive process exit. A request whose
  delivery becomes unknown may arrive after its lock is released. The tombstone
  fences later admission, not that issued request; durable reconciliation is
  needed to compensate late arrival. Unknown registration receipts are retained
  because the shared outbox cannot safely retire them, and still consume a slot.

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
