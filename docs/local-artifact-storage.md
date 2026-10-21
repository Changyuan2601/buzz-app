# Local artifact storage

`ctx.artifactStorage` gives plugins durable local reads. It uses IndexedDB in the
host window. It does not request relay data. Shared writes use the host delivery
service. The bounded channel cache remains separate.

A plugin opens a collection for its current identity and community:

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

The host derives the plugin identity from Cordis. The saved community selection
supplies the viewer and relay origin, including while the network is unavailable.
A collection captures that scope. Its read-only `scope` descriptor supplies
`viewer`, normalized `relay`, and the legacy `partition` string for migration.
A handle rejects calls after the identity or relay changes.
Close the handle when its view ends. Subscribe before the first read. Notifications
follow a committed transaction and reach other windows through BroadcastChannel.
They carry no saved content. Each window reads IndexedDB again.

The projector defines index names, exact string values, and lexical order keys.
Several entries can index the same record. Pages use an exclusive `(order, id)`
cursor. Each page reads only its selected records, with a maximum of 1,000 rows.
Pages are independent transactions. A change between pages can move a row; restart
the query after a notification. All windows must use the same collection type,
version, and projector. Projection behavior, index definitions, and query semantics
tied to saved state must stay fixed within a version. Changes require a version
increase. The host checks the declared version in each read or write transaction.
It cannot detect undeclared changes to a projector. Increase the version to rebuild
saved indexes in one transaction. A failed rebuild preserves the saved version and
data. An incompatible type fails explicitly. An older handle then rejects further
reads and writes. If opening the database
fails, close the failed handle and open another after the cause clears.

`get(id)` returns a saved artifact and its separate preference. A record contains
the current revision, conflicting heads, unresolved ancestry, known availability,
and an optional local snapshot. A cached body is not proof of current access.
A missing parent remains unresolved. An older revision cannot replace a known
descendant. Conflicting heads preserve the last usable view. A descendant of all
heads resolves the conflict. The host retains ancestry edges for comparison.

`preferences.update(id, change)` reads the latest value, calls the synchronous
callback, saves its result, and rebuilds that row's indexes in one transaction.
Preferences remain in a separate store. Values such as `false` and `null` remain
explicit. The callback must return JSON and must not start asynchronous work.

`importBatch` supports migration of device data. It inserts missing local snapshots
and preferences. It does not invent a shared revision or replace later edits. The
plugin owns the snapshot fields, including origin. Its optional completion marker
commits with the last batch. `imported(marker)` confirms that commit. Keep the
source data until this check succeeds.

The host collection adds these operations for sync:

- `applyBatch` saves verified revisions, availability changes, and a checkpoint
  in one strict transaction. The checkpoint compares its expected value first.
- `checkpoint` reads the saved checkpoint for owner transfer.
- `beginSnapshot(source)` captures a local commit sequence and a new generation.
- `applyBatch({ source, snapshot, ... })` marks received IDs seen in that generation.
  Its `seen` entries can reference revisions already saved on this device.
  Snapshot authority can select a current head when history is missing. It keeps
  unresolved ancestry and competing heads. A capture sequence fences later writes.
  Superseded heads cannot become current through a late snapshot.
- Availability updates compare `expectedRevision` with the saved current revision.
  Snapshot availability also uses the capture sequence. Validated current revisions
  can update the saved channel home.
- `completeSnapshot(snapshot, checkpoint)` reconciles absent records for only that
  source, then commits the checkpoint. Live and confirmed writes after capture
  remain available. A record remains available while another source still contains
  it. Content, local snapshots, and preferences remain saved.

`source` is an exact authoritative query scope supplied by sync. The sync owner
must validate server completion and current access before it calls
`completeSnapshot`. Pass the live interval's AbortSignal to cancel the local
transaction if continuity fails or the owner closes. A failed or invalidated snapshot must not complete. A new
snapshot for the same source invalidates the old generation. Checkpoints are
opaque strings; this store does not require a durable server cursor.

`ArtifactStorageService.onOpen` lets host sync attach to a collection and its type
descriptor and a lifetime AbortSignal. Closing the handle or changing identity or
community aborts that signal. Sync uses one Web Lock per
`{viewer, relay, owner, collectionName}`. Only a window with the real collection
definition can own that work. Checkpoints and snapshot completion stay within that
collection and its exact source query. The owner cancels work before it releases
the lock. A late response cannot commit after the owner closes. Outbox ownership
uses its separate host service. Records, preferences, and source membership are
isolated by collection. Leaving a community purges only its saved partition.
Plugins receive the read, preference, and migration contract. They do
not receive `applyBatch` or transport access. The task plugin owns task fields,
parent rules, search tokens, and the meaning of device preferences.
