# Artifact sync and message delivery

The host saves confirmed relay artifacts through `ArtifactStorageService`. Plugins own each collection definition and projector. A Web Lock covers `{viewer, relay, owner, collectionName}`. Only a window with that definition can own the sync work. The owner cancels reads and waits for commits before it releases the lock. The message outbox has a separate lock for `{viewer, relay}`. Each retained relay session keeps its lock until disposal. Community selection does not stop pending delivery.

## Snapshot contract

Sync uses the existing relay session and socket. It needs the version 1 `artifacts.snapshot` capability. The relay must support a stable manifest of artifact IDs, exact revision IDs, and channel IDs. It must validate access and completion. Offset pages do not meet this contract.

The client saves validated bodies during capture. It starts with 100 bodies per request. It splits a batch when the relay returns `snapshot_limit`. Saved bodies remain available after an interrupted capture. A retry can reuse them. Only valid completion permits absence reconciliation. Preferences and pending edits remain separate from confirmed rows. A reset, expired token, changed access, or lost connection prevents completion.

Each collection has one fixed query. Live events and accepted local writes request a background refresh. They do not write confirmed records. The store applies authoritative snapshot pages in generation order. The client has no revision ancestry graph. Repairs run after reconnect, collection changes, roster changes, and live hints. Channel activity alone does not request repair. A 60-second repair covers homes outside active message routes. Repairs are sequential within a collection. Transient failures get three short retries before the next repair interval. Capture admission failures use the repair interval directly. Live traffic cannot bypass that delay. A failed refresh saves an error after retries. A successful completion clears it. Local reads do not wait for repair.

The relay snapshot PR is a prerequisite. A relay without the capability keeps the saved view. This client does not invent a checkpoint from ordinary query results.

The relay rejects capture when active memberships exceed 50,000, before query filters. Archived memberships count toward this limit. A narrower query does not remove it. The client retains saved data and pending edits on `snapshot_limit`. Body-batch limits use bounded batch reduction. They do not establish a higher capture limit.

## Live channel groups

Large joined rosters use live groups of at most 1,000 channels. Each group stays open while recent replay reads run in groups of ten channels. At most four requests await EOSE. Each replay filter keeps its 500-event limit. EOSE establishes a route; it does not prove that history is complete. A full limit remains incomplete evidence. Existing finite catch-up owns older gaps. The agent runner retains its event-ID checks before dispatch.

Admission counts retained routes. New joined channels fill groups with space. Retired membership scopes remain fenced. The transport accepts at most 100,000 channel interests. Singleton previews consume separate routes. Demand beyond route capacity gets a limited status. Grouped interests preserve ordinary chat and all-channel agent watches. They do not make 100,000 simultaneous agent runs a supported workload.

The relay permits 1,024 subscriptions, ten filters per request, and 2,048 explicit channel values per request. The default frame limit is 524,288 bytes. Browser broker controls and status frames have a separate 32 MiB bound because their local status includes each channel. This bound does not change relay event limits.

## Managed delivery

`session.messagesForRecipient(agentPubkey)` uses the existing message validation and composer path. `EmbeddedThread.managedRecipient` selects this path for a task conversation. Ordinary chat keeps its existing behavior. `session.delivery.submit(input)` admits kind-45010 artifact operations. `delivery.submit(input,{operationKey,collection:{owner,name}})` saves a caller key with artifact intent. Submits serialize across windows. `delivery.lookup(operationKey)` finds that retained intent after a restart. The same key rejects different input. This closes the gap before a caller saves the returned ID. Key lookup lasts while the journal retains the record.

`delivery.artifact(id)` returns bounded, newest-first entries with `template`, `state`, and `confirmed`. Unconfirmed edits remain in the pending journal. They do not enter the bounded completed cache. A failed publication retains the attempted value and relay error. The client does not rebase stale writes automatically. A caller can display these entries over confirmed rows.

Before each capture starts, sync freezes the accepted operation IDs for that collection. Only successful server and local completion can confirm those IDs. A later accepted operation needs another capture. A subsequent relay revision or legitimate absence can confirm an earlier edit. The accepted revision need not remain current. A local confirmation save failure retains acceptance and the pending value, then exposes an error. It never republishes the accepted event.

`delivery.get(id)` is asynchronous. `delivery.subscribe(listener)` reports durable state changes.

The outbox saves intent and the signed event before publication. Artifact events keep their supplied envelope tags. Identical submissions with the same signed event ID share one operation. It retains the same event ID across uncertain retries. The owner makes at most three attempts before an error. A definitive relay refusal stops automatic retries. An explicit retry clears the refusal. A settled refusal can be discarded. Acceptance and exact agent receipt are separate saved facts. Stale writes from another window cannot clear either fact. Within one retry round, merges preserve receipt deadlines, retry delays, and errors. A new round permits an explicit retry.

`AgentRun.received(messageIds)` reports only the exact original message IDs. The host binds the channel and agent identity. The plugin calls it at a verified harness receipt boundary. Process start, typing, and an unrelated reply do not prove receipt. The host saves receipt before it clears the opacity pulse. A save failure keeps accepted evidence and exposes an unconfirmed state.

Normal managed delivery has no extra status label. Message opacity pulses until exact receipt. Reduced motion uses static opacity. After 30 seconds without receipt, the pulse stops and the message shows `Could not confirm delivery`. `Check again` rereads saved evidence and permits a late exact callback. It never republishes an accepted message. A later exact receipt clears the error.

Exact receipt is local in v0. A crash before receipt persistence, or receipt on another device, can leave an accepted message unconfirmed. There is no remote receipt recovery protocol. Kind 44200 is a completed-turn usage metric and cannot carry a receipt-only event. A separate protocol is necessary to remove this ambiguity.

## Verification limits

Focused tests cover publication, exact receipt, restart, stale writes, lost confirmations, refusal, expiry, and completion fences. Browser checks use real IndexedDB, BroadcastChannel, and Web Locks in Chromium and WebKit. They cover keyed submits across windows, restart, and a stale save after capture confirmation. The socket scale check covers 10,000 active homes plus 50,000 archive homes and a normal chat. It verifies grouping and request bounds with a test socket. It does not measure the deployed relay's startup cost or establish snapshot support above its membership limit.

A separate macOS bundle uses the saved debug identity and the installed Nexus plugin. Native storage checks verify restart, indexed reads, explicit false preferences, and committed notifications. Native checks of pending artifact views under the single-query contract remain pending. DOM checks verify the pulse in both themes, the receipt timeout, and focus and activation of `Check again`. The accepted event ID stays the same. These checks do not include screenshots, width changes, or enlarged text.

Real snapshot verification requires the relay prerequisite and this client together. The live community does not advertise snapshot support. Exact receipt from a real harness requires the Nexus adoption layer. Unit and browser checks verify the bound callback and saved receipt state.
