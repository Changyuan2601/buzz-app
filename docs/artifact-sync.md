# Local artifact sync

The host saves relay records through `ArtifactStorageService`. Each plugin defines one collection and one fixed query. A Web Lock covers `{viewer,relay,owner,collectionName}`. Its owner cancels reads and waits for commits before it releases the lock.

The native transport exposes `session.artifactSync` when the relay advertises the exact `artifacts.sync` v1 contract. It covers permanent channels, 100-row pages, 100-ID current reads, an 8 MiB response bound, and a 30-day checkpoint lifetime. The relay prerequisite is [PR 8523](https://github.com/block/buzz/pull/8523).

The first read discovers authorized records. Later reads use a checkpoint with a 120-second overlap from the last successful server start time. Only a full paged pass saves progress. Live pushes request current-ID reads through the same collection queue. They do not advance progress or directly write saved rows. The existing outbox acceptance observer also requests a current read.

The client applies signed upserts and explicit removals. A removal uses the locally observed revision for a conditional write. It retains the body and preferences, and marks the record unavailable. A failed commit prevents progress. Empty replies never establish absence.

A policy change or an expired checkpoint requires a fresh query plus bounded revalidation of saved IDs. Missing, unmatched, and unauthorized IDs return the same unavailable result. Recovery saves progress only after both steps succeed. It does not return a hidden roster.

Refresh generations, schema checks, and owner cancellation fence each commit. Failed reads keep saved progress and data. Transient failures get three short retries, then a 60-second delay. Invalid replies and capacity failures use that delay directly. A persistent failure exposes `refreshError()`. Successful delta completion clears it. A 60-second repair runs independently of live traffic. A bounded set holds up to 1,000 live IDs; overflow requests another delta.

The 120-second overlap assumes bounded database delay. It does not prove recovery from every delayed commit. TTL retirement is outside this contract. Native end-to-end verification needs the compatible relay and client together.
