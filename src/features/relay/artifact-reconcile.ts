import type {
  HostArtifactCollection,
  ReceivedArtifact,
} from "../artifact-storage/types";
import { eventDto, type RelayEvent } from "./events";
import {
  ARTIFACT_SNAPSHOT_LIMITS,
  ArtifactSnapshotError,
  type ArtifactManifestEntry,
  type ArtifactSnapshotReader,
} from "./artifact-snapshot";

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

/** Pages can commit during a failed refresh. Only validated completion admits absence. */
export async function reconcileArtifactSnapshot(
  reader: ArtifactSnapshotReader,
  collection: HostArtifactCollection,
  type: string,
  signal: AbortSignal,
  options: { reportFailure?: boolean; onComplete?: () => Promise<void> } = {},
) {
  const source = JSON.stringify({
    artifact: "current",
    kinds: [45010],
    "#type": [type],
  });
  const expected = await collection.checkpoint();
  signal.throwIfAborted();
  const snapshot = await collection.beginSnapshot(source);
  try {
    let page = await reader.start(
      { artifact: "current", kinds: [45010], "#type": [type] },
      signal,
    );
    const token = page.token;
    const seen = new Set<string>();
    const cursors = new Set<string>();
    async function saveBodies(
      entries: readonly ArtifactManifestEntry[],
    ): Promise<void> {
      if (!entries.length) return;
      let events: readonly RelayEvent[];
      try {
        events = await reader.bodies(token, entries, signal);
      } catch (error) {
        if (
          !(error instanceof ArtifactSnapshotError) ||
          error.code !== "snapshot_limit" ||
          entries.length === 1
        )
          throw error;
        const middle = Math.ceil(entries.length / 2);
        await saveBodies(entries.slice(0, middle));
        await saveBodies(entries.slice(middle));
        return;
      }
      signal.throwIfAborted();
      const records = events.map((event) => receivedArtifact(event, type));
      await collection.applyBatch(
        {
          source,
          snapshot,
          records,
          availability: records.map((record) => ({
            id: record.id,
            expectedRevision: record.revision.id,
            value: { state: "available" as const },
          })),
        },
        signal,
      );
      signal.throwIfAborted();
    }
    while (true) {
      signal.throwIfAborted();
      const cached: { id: string; revisionId: string }[] = [];
      const missing: ArtifactManifestEntry[] = [];
      for (const entry of page.entries) {
        if (
          seen.has(entry.artifactId) ||
          seen.size >= ARTIFACT_SNAPSHOT_LIMITS.maxRows
        )
          throw new Error("Artifact manifest repeats or exceeds capacity");
        seen.add(entry.artifactId);
        const saved = await collection.get(entry.artifactId);
        signal.throwIfAborted();
        const revision = saved?.record.current;
        if (revision?.id === entry.revisionId && revision.event) {
          const event = eventDto(revision.event);
          const record = receivedArtifact(event, type);
          if (
            record.id !== entry.artifactId ||
            record.channelId !== entry.channelId ||
            event.content !== revision.content
          )
            throw new Error("Saved artifact does not match its revision");
          cached.push({ id: entry.artifactId, revisionId: entry.revisionId });
        } else missing.push(entry);
      }
      if (cached.length)
        await collection.applyBatch(
          {
            source,
            snapshot,
            seen: cached,
            availability: cached.map((entry) => ({
              id: entry.id,
              expectedRevision: entry.revisionId,
              value: { state: "available" as const },
            })),
          },
          signal,
        );
      for (
        let offset = 0;
        offset < missing.length;
        offset += ARTIFACT_SNAPSHOT_LIMITS.bodyRows
      )
        await saveBodies(
          missing.slice(offset, offset + ARTIFACT_SNAPSHOT_LIMITS.bodyRows),
        );
      if (page.nextToken === null) break;
      if (cursors.has(page.nextToken))
        throw new Error("Artifact snapshot page cursor repeats");
      cursors.add(page.nextToken);
      page = await reader.page(token, page.nextToken, signal);
    }
    await reader.complete(token, signal);
    signal.throwIfAborted();
    await collection.completeSnapshot(
      snapshot,
      { expected, next: token },
      signal,
    );
  } catch (error) {
    const permanent =
      error instanceof ArtifactSnapshotError &&
      [
        "snapshot_limit",
        "snapshot_unsupported_scope",
        "snapshot_invalid",
      ].includes(error.code);
    if (!signal.aborted && (options.reportFailure || permanent)) {
      await collection.setRefreshError(
        snapshot,
        error instanceof ArtifactSnapshotError &&
          error.code === "snapshot_limit"
          ? "The relay limit prevents a refresh of saved data"
          : "Could not refresh saved data",
        signal,
      );
    }
    throw error;
  }
  await options.onComplete?.();
}
