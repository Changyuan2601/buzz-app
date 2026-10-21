import type { JsonValue } from "../navigation/targets";
import type { RelayEvent } from "../relay/events";

export type ArtifactRevision = Readonly<{
  id: string;
  parents: readonly string[];
  content: string;
  event?: RelayEvent;
}>;
export type ArtifactAvailability = Readonly<{
  state: "unknown" | "available" | "unavailable" | "deleted";
  reason?: string;
}>;
export type SavedArtifact = Readonly<{
  id: string;
  channelId?: string;
  type?: string;
  current?: ArtifactRevision;
  conflicts: readonly ArtifactRevision[];
  /** At least one parent is missing from the saved ancestry. */
  unresolved: boolean;
  /** Cached content does not establish current access. */
  availability: ArtifactAvailability;
  /** A plugin-owned snapshot, without shared revision proof. */
  local?: JsonValue;
}>;
export type ArtifactEntry = Readonly<{
  record: SavedArtifact;
  preference?: JsonValue;
}>;
export type ArtifactIndex = Readonly<{
  index: string;
  value: string;
  order: string;
}>;
export type ArtifactCollectionDefinition = Readonly<{
  name: string;
  /** The shared artifact type admitted by this collection. */
  type: string;
  /** Increase when the projection changes. Saved rows are reindexed atomically. */
  version: number;
  project(entry: ArtifactEntry): readonly ArtifactIndex[];
}>;
export type ArtifactPageQuery = Readonly<{
  index: string;
  value: string;
  limit?: number;
  after?: Readonly<{ order: string; id: string }>;
}>;
export type ArtifactPage = Readonly<{
  entries: readonly ArtifactEntry[];
  next?: Readonly<{ order: string; id: string }>;
}>;
export type ArtifactImport = Readonly<{
  records?: readonly Readonly<{ id: string; local: JsonValue }>[];
  preferences?: readonly Readonly<{ id: string; value: JsonValue }>[];
  /** The final batch and this marker commit together. */
  marker?: string;
}>;
export type ArtifactCollection = {
  readonly scope: Readonly<{
    viewer: string;
    relay: string;
    partition: string;
  }>;
  get(id: string): Promise<ArtifactEntry | undefined>;
  page(query: ArtifactPageQuery): Promise<ArtifactPage>;
  /** Subscribe before the first read. Each notification requires a fresh read. */
  subscribe(listener: () => void): () => void;
  preferences: {
    get(id: string): Promise<JsonValue | undefined>;
    update(
      id: string,
      change: (current: JsonValue | undefined) => JsonValue,
    ): Promise<void>;
  };
  /** Inserts absent snapshots and preferences. Retries preserve later edits. */
  importBatch(batch: ArtifactImport): Promise<void>;
  imported(marker: string): Promise<boolean>;
  close(): void;
};
export type ReceivedArtifact = Readonly<{
  id: string;
  channelId: string;
  type: string;
  revision: ArtifactRevision;
}>;
export type ArtifactSnapshot = Readonly<{
  source: string;
  generation: string;
  captureSequence: number;
}>;
export type ArtifactBatch = Readonly<{
  /** Exact authoritative query scope, defined by the sync owner. */
  source: string;
  snapshot?: ArtifactSnapshot;
  records?: readonly ReceivedArtifact[];
  /** Snapshot members whose revision is already saved. */
  seen?: readonly Readonly<{ id: string; revisionId: string }>[];
  availability?: readonly Readonly<{
    id: string;
    expectedRevision: string | null;
    value: ArtifactAvailability;
  }>[];
  checkpoint?: Readonly<{ expected: string | null; next: string }>;
}>;
/** Host-only writes. Plugins submit shared changes through the delivery service. */
export type HostArtifactCollection = ArtifactCollection & {
  applyBatch(batch: ArtifactBatch): Promise<void>;
  checkpoint(): Promise<string | null>;
  beginSnapshot(source: string): Promise<ArtifactSnapshot>;
  /** The caller validates server completion before this local transaction. */
  completeSnapshot(
    snapshot: ArtifactSnapshot,
    checkpoint: { expected: string | null; next: string },
    signal?: AbortSignal,
  ): Promise<void>;
};
