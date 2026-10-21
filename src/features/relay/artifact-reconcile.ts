import type {
  HostArtifactCollection,
  ReceivedArtifact,
} from "../artifact-storage/types";
import type { RelayEvent } from "./events";
import {
  ARTIFACT_SYNC_LIMITS,
  ArtifactSyncError,
  type ArtifactSyncChange,
  type ArtifactSyncReader,
} from "./artifact-reader";
import type { ArtifactRefresh } from "../artifact-storage/types";

export function receivedArtifact(
  event: RelayEvent,
  type: string,
): ReceivedArtifact {
  const one = (name: string) => {
    const tags = event.tags.filter(([key]) => key === name);
    if (tags.length !== 1 || tags[0]?.length !== 2)
      throw new Error("Invalid artifact envelope");
    return tags[0][1] as string;
  };
  const id = one("d");
  const channelId = one("h");
  const op = one("op");
  const previous = event.tags.filter(([key]) => key === "prev");
  if (
    event.kind !== 45010 ||
    one("ar") !== "1" ||
    one("type") !== type ||
    !["create", "update", "move", "delete", "restore"].includes(op) ||
    (op === "create"
      ? previous.length !== 0
      : previous.length !== 1 ||
        previous[0]?.length !== 2 ||
        !/^[0-9a-f]{64}$/.test(previous[0]?.[1] ?? ""))
  )
    throw new Error("Invalid artifact envelope");
  return {
    id,
    channelId,
    type,
    revision: {
      id: event.id,
      content: event.content,
      event,
    },
  };
}

const queryFor = (type: string) => ({
  artifact: "current" as const,
  kinds: [45010] as const,
  "#type": [type],
});
const sourceFor = (type: string) => JSON.stringify(queryFor(type));
function savedCheckpoint(value: string | null): string | undefined {
  if (!value) return;
  try {
    const saved = JSON.parse(value);
    if (saved?.protocol === "sync-v1" && typeof saved.checkpoint === "string")
      return saved.checkpoint;
  } catch {}
}
async function applyChanges(
  collection: HostArtifactCollection,
  refresh: ArtifactRefresh,
  changes: readonly ArtifactSyncChange[],
  type: string,
  signal: AbortSignal,
) {
  let records: ReceivedArtifact[] = [];
  let availability: NonNullable<
    Parameters<HostArtifactCollection["applyBatch"]>[0]["availability"]
  >[number][] = [];
  async function flush() {
    if (!records.length && !availability.length) return;
    await collection.applyBatch(
      { source: refresh.source, refresh, records, availability },
      signal,
    );
    records = [];
    availability = [];
  }
  async function remove(id: string, channelId?: string) {
    const saved = await collection.get(id);
    signal.throwIfAborted();
    if (
      !saved ||
      (channelId !== undefined && saved.record.channelId !== channelId)
    )
      return;
    availability.push({
      id,
      expectedRevision: saved.record.current?.id ?? null,
      value: { state: "unavailable" },
    });
  }
  const pending = new Set<string>();
  for (const change of changes) {
    signal.throwIfAborted();
    if (change.type !== "removeChannel" && pending.has(change.artifactId)) {
      await flush();
      pending.clear();
    }
    if (change.type !== "removeChannel") pending.add(change.artifactId);
    if (change.type === "upsert") {
      const record = receivedArtifact(change.event, type);
      records.push(record);
      availability.push({
        id: record.id,
        expectedRevision: record.revision.id,
        value: { state: "available" },
      });
    } else if (change.type === "remove") await remove(change.artifactId);
    else {
      await flush();
      pending.clear();
      let after: string | undefined;
      do {
        const page = await collection.knownIds({
          channelId: change.channelId,
          ...(after !== undefined ? { after } : {}),
          limit: 1000,
        });
        signal.throwIfAborted();
        for (const id of page.ids) await remove(id, change.channelId);
        await flush();
        after = page.next;
      } while (after !== undefined);
    }
  }
  await flush();
}
async function currentBatch(
  reader: ArtifactSyncReader,
  collection: HostArtifactCollection,
  refresh: ArtifactRefresh,
  type: string,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  try {
    const result = await reader.current(queryFor(type), ids, signal);
    signal.throwIfAborted();
    await applyChanges(collection, refresh, result.changes, type, signal);
  } catch (error) {
    if (
      !(error instanceof ArtifactSyncError) ||
      error.code !== "sync_limit" ||
      ids.length === 1
    )
      throw error;
    const middle = Math.ceil(ids.length / 2);
    await currentBatch(
      reader,
      collection,
      refresh,
      type,
      ids.slice(0, middle),
      signal,
    );
    await currentBatch(
      reader,
      collection,
      refresh,
      type,
      ids.slice(middle),
      signal,
    );
  }
}
async function revalidateKnown(
  reader: ArtifactSyncReader,
  collection: HostArtifactCollection,
  refresh: ArtifactRefresh,
  type: string,
  signal: AbortSignal,
) {
  let after: string | undefined;
  do {
    const page = await collection.knownIds({
      ...(after !== undefined ? { after } : {}),
      limit: ARTIFACT_SYNC_LIMITS.currentRows,
    });
    signal.throwIfAborted();
    if (page.ids.length)
      await currentBatch(reader, collection, refresh, type, page.ids, signal);
    after = page.next;
  } while (after !== undefined);
}
async function reportFailure(
  collection: HostArtifactCollection,
  refresh: ArtifactRefresh,
  error: unknown,
  signal: AbortSignal,
  requested: boolean,
) {
  const permanent =
    error instanceof ArtifactSyncError &&
    ["sync_limit", "sync_invalid"].includes(error.code);
  if (!signal.aborted && (requested || permanent))
    await collection.setRefreshError(
      refresh,
      error instanceof ArtifactSyncError && error.code === "sync_limit"
        ? "The relay limit prevents a refresh of saved data"
        : "Could not refresh saved data",
      signal,
    );
}
export async function reconcileArtifactCurrent(
  reader: ArtifactSyncReader,
  collection: HostArtifactCollection,
  type: string,
  ids: readonly string[],
  signal: AbortSignal,
  options: { reportFailure?: boolean } = {},
) {
  const refresh = await collection.beginRefresh(sourceFor(type));
  try {
    for (
      let offset = 0;
      offset < ids.length;
      offset += ARTIFACT_SYNC_LIMITS.currentRows
    )
      await currentBatch(
        reader,
        collection,
        refresh,
        type,
        ids.slice(offset, offset + ARTIFACT_SYNC_LIMITS.currentRows),
        signal,
      );
    signal.throwIfAborted();
  } catch (error) {
    await reportFailure(
      collection,
      refresh,
      error,
      signal,
      options.reportFailure === true,
    );
    throw error;
  }
}
export async function reconcileArtifactDelta(
  reader: ArtifactSyncReader,
  collection: HostArtifactCollection,
  type: string,
  signal: AbortSignal,
  options: { reportFailure?: boolean } = {},
) {
  const expected = await collection.checkpoint();
  signal.throwIfAborted();
  const refresh = await collection.beginRefresh(sourceFor(type));
  let checkpoint = savedCheckpoint(expected);
  let recovery = checkpoint === undefined;
  try {
    let next: string;
    while (true) {
      try {
        let cursor: string | undefined;
        let startedAt: string | undefined;
        const cursors = new Set<string>();
        while (true) {
          const page = await reader.delta(
            queryFor(type),
            {
              ...(checkpoint !== undefined ? { checkpoint } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
            },
            signal,
          );
          signal.throwIfAborted();
          if (startedAt !== undefined && page.startedAt !== startedAt)
            throw new Error("Artifact sync capture changes between pages");
          startedAt = page.startedAt;
          await applyChanges(collection, refresh, page.changes, type, signal);
          if (page.nextCursor === null) {
            if (!page.checkpoint)
              throw new Error("Artifact sync completion has no checkpoint");
            next = page.checkpoint;
            break;
          }
          if (cursors.has(page.nextCursor))
            throw new Error("Artifact sync page cursor repeats");
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        break;
      } catch (error) {
        if (
          !(error instanceof ArtifactSyncError) ||
          error.code !== "sync_reset" ||
          recovery
        )
          throw error;
        checkpoint = undefined;
        recovery = true;
      }
    }
    if (recovery)
      await revalidateKnown(reader, collection, refresh, type, signal);
    signal.throwIfAborted();
    await collection.completeRefresh(
      refresh,
      {
        expected,
        next: JSON.stringify({ protocol: "sync-v1", checkpoint: next }),
      },
      signal,
    );
  } catch (error) {
    await reportFailure(
      collection,
      refresh,
      error,
      signal,
      options.reportFailure === true,
    );
    throw error;
  }
}
