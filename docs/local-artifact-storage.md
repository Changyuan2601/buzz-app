# Local artifact storage

`ctx.artifactStorage` gives plugins durable local reads through IndexedDB. The
bounded channel cache stays separate. The host delivery service owns shared edits.
The plugin owns task fields, parent rules, search tokens, and device preferences.

```ts
const tasks = ctx.artifactStorage.open({
  name: "tasks",
  type: "example.task",
  version: 1,
  project({ record, preference }) {
    return [{ index: "all", value: "", order: record.id }];
  },
});
const stop = tasks.subscribe(() => { /* Read the affected page again. */ });
const page = await tasks.page({ index: "all", value: "", limit: 100 });
const next = page.next
  ? await tasks.page({ index: "all", value: "", after: page.next, limit: 100 })
  : undefined;
```

## Scope and indexes

Cordis supplies the plugin identity. The saved community selection supplies the
viewer and normalized relay, including while offline. The read-only `scope`
contains `viewer`, `relay`, and the legacy `partition` string for migration.
A handle closes when its identity or community changes. Close it when its view ends.

Records and preferences are isolated by viewer, relay, plugin, and collection.
Each collection admits one artifact type and one fixed authoritative query. Sync
binds that query through its opaque `source` string. A different source fails.
Change the collection version when projection behavior, index definitions, or
saved query semantics change. The host checks the declared version in each read
and write transaction. It cannot detect undeclared changes to projector behavior.
An incompatible type fails explicitly. An index rebuild commits atomically; a
failure preserves the saved version and data. Old handles then reject operations.

The projector defines exact string index values and lexical order keys. Several
entries can index a record. Pages use an exclusive `(order, id)` cursor and read
only selected records, with a maximum of 1,000 rows. Pages are independent
transactions. Restart a query after a notification when rows can move between pages.
Notifications follow commit and reach other windows through BroadcastChannel.
They contain no saved content. Subscribe before the first read, then read again.

## Device data

`preferences.update(id, change)` reads the latest preference, calls the synchronous
callback, saves the result, and rebuilds that row's indexes in one transaction.
Preferences stay in a separate store. Values such as `false` and `null` remain
explicit. The callback must return JSON and must not start asynchronous work.

`importBatch` inserts absent local snapshots and preferences. Retries preserve
later edits. It does not invent a shared revision. A completion marker commits
with the last batch. Keep migration source data until `imported(marker)` succeeds.

## Confirmed shared state

The relay supplies one authoritative current revision per artifact. The store
saves that result without an ancestry graph, inferred conflicts, revision homes,
or timestamp ordering. `get(id)` returns the current revision, availability,
optional plugin-owned local snapshot, and separate preference. Cached content
alone does not establish current access. Publication conflicts are delivery errors;
the delivery view retains the user's attempted edit for correction.

`ArtifactStorageService.onOpen` supplies the host with the real collection
definition, its handle, scope, and lifetime AbortSignal. Sync uses one Web Lock per
`{viewer, relay, owner, collectionName}`. Only a window with that definition can
own its sync. Outbox ownership stays separate. The owner cancels its work before
it releases the lock. The collection also aborts its pending transactions on close.

The host-only contract provides:

- `beginSnapshot(source)` binds the fixed query and starts a fresh local generation.
  A newer generation retires the previous one.
- `applyBatch({source, snapshot, records, seen, availability, checkpoint}, signal)`
  commits a validated page atomically. It requires the active generation. `seen`
  reuses a body only when its exact current revision ID is saved. Availability
  checks the expected revision. An optional checkpoint compares its expected value.
- `completeSnapshot(snapshot, checkpoint, signal)` runs only after sync validates
  server completion. In one transaction, it marks absent shared records
  unavailable, commits the checkpoint, and clears the refresh error. Saved bodies,
  local snapshots, and preferences remain. Device-only records stay device-only.
- `setRefreshError(snapshot, message, signal)` saves an error for the active
  generation and publishes a notification. Plugins read `refreshError()` and show
  a nonempty error. A new attempt retains that error until successful completion.
- `checkpoint()` reads the saved opaque checkpoint.

No raw live event, accepted edit, or per-artifact write can change confirmed
shared state. Live events request an automatic background refresh. Reconnect also
starts a refresh. A failed capture may leave validated bodies for exact-ID reuse.
Only validated completion can infer absence. Generation, query, schema, checkpoint,
and cancellation checks run inside the transaction. An old owner cannot commit
late pages, completion, or errors after cancellation or a generation change.

## Immediate local feedback

Device preferences update immediately. Shared edits use the existing delivery
journal and appear immediately in the plugin's pending view. Relay acceptance
starts a fresh capture. A pre-acceptance capture cannot reconcile that pending
edit. A successful capture begun after acceptance can show the accepted edit, a
later revision, or legitimate absence. Reconciling an older operation must preserve
any newer pending edit. Sync and delivery own this boundary; the row store does not
merge optimistic edits into confirmed state. Offline shared edits remain undecided.

## Storage costs

Writes request strict durability. Transactions span all four object stores, so
large batches can delay other collections' reads or writes. A changed row rewrites
its indexes. Index upgrades and absence reconciliation scan the collection.
Ancestry comparison and separate source-membership writes are absent. The database
upgrade removes the obsolete membership store and preserves records and device
preferences. Leaving a community purges only its saved partition. If database
opening fails, close that handle and open another after the cause clears.
