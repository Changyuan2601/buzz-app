# Shared agent attention

The agent runner owns event watches and timers. It uses its existing five-second tick. Native custody selects one app instance on each machine. The relay admits each shared occurrence across machines.

## Definition and capability

`Agents.sharedAttention.capability(pubkey)` returns `{ supported, reason? }`. A supported host has a local runnable agent, a live community session, a fresh snapshot reader, an artifact writer, and advertised `nip-ar` support. A browser host does not expose this new capability. Plugins must check it before enable or Run now.

A watch or timer can include this reference:

```ts
shared: {
  channel_id: taskChannelId,
  definition_id: definitionId,
  definition_revision: signedDefinitionEventId,
}
```

The definition is an artifact in that channel. Its `d` tag equals `definition_id`. Its body has `id: definition_id` and `enabled: true`. The revision is the exact signed event ID. The plugin owns the definition body, task references, conditions, and destination session. Each device installs the same reference in its local attention record. `Agents.save` and `AgentHandle.attention.write` accept the extended attention format.

The host reads the current definition directly from the relay before admission and again before dispatch. A cached body does not establish its revision or enabled state. An edit, deletion, disable, local attention change, or retired agent stops queued work. Disable does not revoke work already dispatched to an agent type.

## Schedules

A timer can add `cron_utc`. It has five numeric fields: minute, hour, day of month, month, and day of week. Fields accept `*`, comma lists, inclusive ranges, and positive steps. Steps range from 1 to the field width. `n/step` selects values from `n` to the field maximum. Sunday is 0 or 7. When both day fields restrict values, either can match. A wildcard day field requires the other day field to match. Names, macros, seconds, and time zones are invalid.

Existing timer fields remain required. Set `interval_secs: 60` with `cron_utc`; cron does not use that interval. All attention and occurrence timestamps use Unix seconds.

Cron considers only the current UTC minute. It skips missed minutes. One occurrence can run during a matching minute. Work that waits beyond that minute does not start.

A shared interval starts at `armed_at + interval_secs` when no shared progress exists. An overdue interval runs once. Its next interval starts from the fresh clock read before the host signs its admission. Saved progress survives app restart and transfer to another machine. A changed `armed_at` sets a new deadline and preserves usage. An explicit restart needs a new signed definition revision. A rearm with the same arm time also needs a new revision. Existing timers without `shared` keep their local progress and missed-run behavior.

`sharedAttention.runNow(pubkey, slug, requestId)` queues a shared timer in its existing Interest lane. The caller must retain the UUID `requestId` across retries. The call requires this app to hold the local agent claim. It returns `{ status: "queued", requestId }`; this does not prove dispatch. A confirmed manual admission resets interval progress. The same manual request cannot dispatch twice. Expiry and occurrence limits still apply.

## Admission and progress

The host uses the relay's existing NIP-AR transaction. It serializes artifact identity, checks create or `prev`, stores the revision, and advances the head in one database transaction. See [the relay transaction](https://github.com/block/buzz/blob/main/crates/buzz-db/src/store/artifact.rs) and [its concurrent update test](https://github.com/block/buzz/blob/main/crates/buzz-db/src/store/artifact_postgres_tests.rs).

The host owns `buzz.agent.attention-progress` artifacts. A timer has one subject per definition and revision. An event watch has one subject per source event and definition revision. UUIDv5 derives these subjects from the definition UUID. Manual requests also have a durable subject that prevents request replay. Each timer makes at most one admission attempt per existing tick. A failed shared read does not stop another timer. Shared and local timers use deadline order. Each admission has a random nonce, so two callers cannot sign identical admission events.

Only a confirmed new acceptance grants dispatch. A conflict, duplicate, failed read, or uncertain acceptance grants nothing. A timer update advances its occurrence count and next due time in that same transaction. A manual request consumes its request subject before it changes timer progress. A conflict in that second step cancels the request. An interrupted step leaves uncertainty. Recovery does not dispatch a consumed request.

Each consumed occurrence starts with `result: "uncertain"`. A normal end records `completed` or `failed`. A definition check that stops admitted work records `cancelled`. A crash or lost result receipt leaves `uncertain`. A later completion cannot replace newer timer progress. Earlier revisions retain the earlier consumption record. These results describe the agent runner. The plugin owns delivery reports for the destination session.

`sharedAttention.progress(pubkey, slug, occurrenceId?)` reads current progress from the relay. Omit `occurrenceId` for timer progress. Supply a source event ID for an event watch, or `manual:<requestId>` for a manual request. Local timer summaries are not shared admission evidence.

A shared watch or timer trigger has `occurrence: { id, definition_revision, scheduled_at }`. A catch-up trigger has `occurrences`, paired with its retained events by source event ID. A timer ID is `timer:<scheduled Unix seconds>`. A manual ID is `manual:<requestId>`. An event ID is its signed source event ID. The definition UUID, revision, and occurrence ID identify the run together.

Plugins can import `Agents` from `@buzz/author` and derive the API types:

```ts
import type { Agents } from "@buzz/author";
type SharedAttention = Agents["sharedAttention"];
type Progress = Awaited<ReturnType<SharedAttention["progress"]>>;
```

This host change does not depend on the local store in [PR #1501](https://github.com/block/buzz-app/pull/1501). The Nexus plugin uses the collection and delivery services in [PR #1507](https://github.com/block/buzz-app/pull/1507) for its definitions and destination reports. Shared admission always uses fresh relay reads and direct confirmed writes.
