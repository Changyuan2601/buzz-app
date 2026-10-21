# Artifact sync and message delivery

The host saves confirmed relay artifacts through `ArtifactStorageService`. Plugins own each collection definition and projector. A Web Lock covers `{viewer, relay, owner, collectionName}`. Only a window with that definition can own the sync work. The owner cancels reads and waits for commits before it releases the lock. The message outbox has a separate lock for `{viewer, relay}`. Each retained relay session keeps its lock until disposal. Community selection does not stop pending delivery.

## Sync contract

Sync uses the existing relay session and socket. The native transport exposes `session.artifactSync` only when NIP-11 advertises the exact version 1 `artifacts.sync` contract: `overlapSeconds:120`, `pageRows:100`, `currentRows:100`, and `responseBytes:8388608`, `permanentChannelsOnly:true`, and `checkpointLifetimeSeconds:2592000`. The relay prerequisite is [PR 8523](https://github.com/block/buzz/pull/8523). This client does not deploy it.

Each collection has one fixed current query. An initial paged read discovers authorized artifacts. Later reads use an opaque checkpoint for changes since the last successful server start time, with a 120-second overlap. Live messages do not advance progress. The overlap is a recovery assumption. It does not prove recovery from every delayed database commit. Sync covers permanent channels. TTL retirement is outside this contract.

The relay returns signed current upserts, explicit removals, and retained channel removals. The client validates each response before applying it. Removal keeps cached content and preferences. It marks the row unavailable. A conditional removal uses the locally observed revision. A mismatch fails the commit and prevents progress. Empty or partial replies never establish absence.

One collection owner serializes each whole delta pass and each bounded current-ID read from request start through local commit. Raw live payloads request current-ID reads. They do not replace confirmed rows. Duplicate hints share a bounded set of 1,000 IDs. Overflow requests another delta. Accepted edits remain in the durable delivery journal and do not depend on that set. The client has no revision ancestry graph or local timestamp comparator.

Checkpoint tokens bind the reader, community, exact query, and server start time. A policy change or a checkpoint older than 30 days requires recovery. The client runs a fresh authorized query and revalidates saved IDs in bounded current reads. Missing, unmatched, and unauthorized IDs all receive the same unavailable result. Local-only IDs use that same result. No hidden roster is returned. Both recovery steps must succeed before progress is saved. A failed recovery repeats from saved progress.

The store checks query, schema, refresh generation, owner cancellation, and checkpoint comparison. Pages can save during a failed pass. Only successful completion saves progress and clears the persistent refresh error. A current-ID read does not advance delta progress or clear that error. A failed page cannot advance progress. Late owners cannot commit after cancellation.

Repairs run after reconnect, collection changes, roster changes, and every 60 seconds. Channel activity alone does not request repair. Transient failures get three short retries before the next repair interval. Invalid requests and capacity errors use that interval directly. Live traffic cannot bypass the delay. Current-ID capacity errors split the bounded batch; one oversized result remains an error. Delta pages use the relay byte bound. The sync path has no roster admission limit.

A relay without the exact capability keeps the saved view and rejects new managed artifact intent before persistence. Existing pending work remains saved. A temporary refresh failure does not close the capability gate. Local reads do not wait for repair.

## Live channel groups

Large joined rosters use live groups of at most 1,000 channels. Each group stays open while recent replay reads run in groups of ten channels. At most four requests await EOSE. Each replay filter keeps its 500-event limit. EOSE establishes a route; it does not prove that history is complete. A full limit remains incomplete evidence. Existing finite catch-up owns older gaps. The agent runner retains its event-ID checks before dispatch.

Admission counts retained routes and reserves one wire for group replacement. An expanded group retains its established subset if setup fails transiently. Only added channels need replay when the scope grows. New joined channels fill groups with space. Retired membership scopes remain fenced. The transport accepts at most 100,000 channel interests. Singleton previews consume separate routes. Demand beyond route capacity gets a limited status. Grouped interests preserve ordinary chat and all-channel agent watches. They do not make 100,000 simultaneous agent runs a supported workload.

The relay permits 1,024 subscriptions, ten filters per request, and 2,048 explicit channel values per request. The default frame limit is 524,288 bytes. Browser broker controls and status frames have a separate 32 MiB bound because their local status includes each channel. This bound does not change relay event limits.

## Managed delivery

`session.messagesForRecipient(agentPubkey)` uses the existing message validation and composer path. `EmbeddedThread.managedRecipient` selects this path for a task conversation. Ordinary chat keeps its existing behavior. `session.delivery.submit(input)` admits kind-45010 artifact operations. `delivery.submit(input,{operationKey,collection:{owner,name}})` saves a caller key with artifact intent. Submits serialize across windows. `delivery.lookup(operationKey)` finds that retained intent after a restart. The same key rejects different input. A retained key saves any unsaved intent before it returns success. This closes the gap before a caller saves the returned ID. Key lookup lasts while the journal retains the record.

`delivery.artifact(id)` returns bounded, newest-first entries with `template`, `state`, and `confirmed`. Unconfirmed edits remain in the pending journal. They do not enter the bounded completed cache. A failed publication retains the attempted value and relay error. The client does not rebase stale writes automatically. A caller can display these entries over confirmed rows.

Sync freezes accepted operation IDs before starting an authoritative current-ID read. Only a successful local commit can confirm the covered operations. An acceptance during an in-flight delta or current read needs a later read. An empty delta cannot confirm an edit. A later revision or a uniform unavailable result can confirm an earlier edit. The accepted revision need not remain current. Confirmation preserves a newer pending edit. A local confirmation save failure retains acceptance and the attempted value, then exposes an error. It never republishes the accepted event.

`delivery.get(id)` is asynchronous. `delivery.subscribe(listener)` reports durable state changes.

Artifact intent and other outgoing intent each have a 256-record and 2 MiB pending quota. The combined pending bound is 512 records and 4 MiB. Completed retention stays at 2,048 records and 8 MiB. Artifact exhaustion does not consume chat admission. New writes reserve their signed envelope before enqueue. Restored rows use saved bytes. Signing checks the resulting row before it replaces pending state. If retry status in one full class cannot save, a commit for the other class retains the saved rows of that class.

The outbox saves intent and the signed event before publication. Artifact events keep their supplied envelope tags. Identical submissions with the same signed event ID share one operation. It retains the same event ID across uncertain retries. The owner makes at most three attempts before an error. A definitive relay refusal stops automatic retries. An explicit retry clears the refusal. A settled refusal can be discarded. Acceptance and exact agent receipt are separate saved facts. Stale writes from another window cannot clear either fact. Within one retry round, merges preserve receipt deadlines, retry delays, and errors. A new round permits an explicit retry.

`AgentRun.received(messageIds)` reports only the exact original message IDs. The host binds the channel and agent identity. The plugin calls it at a verified harness receipt boundary. Process start, typing, and an unrelated reply do not prove receipt. The host saves receipt before it clears the opacity pulse. A save failure keeps accepted evidence and exposes an unconfirmed state.

Normal managed delivery has no extra status label. Message opacity pulses until exact receipt. Reduced motion uses static opacity. After 30 seconds without receipt, the pulse stops and the message shows `Could not confirm delivery`. `Check again` rereads saved evidence and permits a late exact callback. It never republishes an accepted message. A later exact receipt clears the error.

Exact receipt is local in v0. A crash before receipt persistence, or receipt on another device, can leave an accepted message unconfirmed. There is no remote receipt recovery protocol. Kind 44200 is a completed-turn usage metric and cannot carry a receipt-only event. A separate protocol is necessary to remove this ambiguity.

## Verification limits

Focused tests cover publication, exact receipt, restart, stale writes, lost confirmations, refusal, expiry, and completion fences. Browser checks use real IndexedDB, BroadcastChannel, and Web Locks in Chromium and WebKit. They cover keyed submits across windows, restart, and a stale save after authoritative confirmation. The socket scale check covers 10,000 active homes plus 50,000 archive homes and a normal chat. It verifies grouping and request bounds with a test socket. It does not measure the deployed relay's startup cost or prove native sync at that scale.

A separate macOS bundle uses the saved debug identity and the installed Nexus plugin. Native storage checks verify restart, indexed reads, explicit false preferences, and committed notifications. Native checks of pending artifact views under the single-query contract remain pending. DOM checks verify the pulse in both themes, the receipt timeout, and focus and activation of `Check again`. The accepted event ID stays the same. These checks do not include screenshots, width changes, or enlarged text.

Native incremental sync verification requires the compatible relay prerequisite and this client together. The last checked live community does not advertise this sync capability. Exact receipt from a real harness requires the Nexus adoption layer. Unit and browser checks verify the bound callback and saved receipt state.
