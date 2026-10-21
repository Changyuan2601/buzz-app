import type { JsonValue } from "../navigation/targets";
import { relayPartition } from "../relay/partition";
import {
  emptyArtifact,
  receiveRevision,
  type StoredArtifact,
} from "./revisions";
import type {
  ArtifactBatch,
  ArtifactCollectionDefinition,
  ArtifactEntry,
  ArtifactImport,
  ArtifactPage,
  ArtifactPageQuery,
  HostArtifactCollection,
  ArtifactSnapshot,
} from "./types";

const DB = "buzz-artifacts-v1";
const STORES = ["records", "preferences", "entries", "metadata", "members"];
type Row = StoredArtifact & {
  scope: string;
  collection: string;
  id: string;
  sequence?: number | undefined;
};
type StoredPreference = { value: JsonValue };

function sameSnapshot(
  left: ArtifactSnapshot | undefined,
  right: ArtifactSnapshot,
) {
  return (
    left?.source === right.source &&
    left.generation === right.generation &&
    left.captureSequence === right.captureSequence
  );
}

/** Same IndexedDB transaction boundary as the relay journals. No head-cache eviction. */
export function createArtifactStore(viewer: string, relay: string) {
  if (!viewer || !relay)
    throw new Error("Artifact storage needs an identity and relay");
  const scope = relayPartition(relay, viewer);
  let closed = false;
  const collections = new Set<HostArtifactCollection>();
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (closed) throw new Error("Artifact storage closed");
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          const store = db.createObjectStore(name, {
            keyPath:
              name === "entries"
                ? ["scope", "collection", "index", "value", "order", "id"]
                : name === "members"
                  ? ["scope", "collection", "source", "id"]
                  : name === "metadata"
                    ? ["scope", "collection", "key"]
                    : ["scope", "collection", "id"],
          });
          if (name === "entries")
            store.createIndex("record", ["scope", "collection", "id"]);
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Close other Buzz windows to open artifact storage"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (closed || blocked) {
          db.close();
          reject(new Error("Artifact storage closed"));
          return;
        }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    return opening;
  }
  type Then = <T>(request: IDBRequest<T>, next: (value: T) => void) => void;
  async function transact<T>(
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction, then: Then, done: (value: T) => void) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const db = await database();
    signal?.throwIfAborted();
    if (closed) throw new Error("Artifact storage closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORES, mode, { durability: "strict" });
      let value: T;
      let failure: unknown;
      const stop = () => {
        try {
          tx.abort();
        } catch (error) {
          if (
            !(
              error instanceof DOMException &&
              error.name === "InvalidStateError"
            )
          )
            throw error;
        }
      };
      const abort = () => {
        failure = signal?.reason;
        stop();
      };
      signal?.addEventListener("abort", abort, { once: true });
      const guard = (fn: () => void) => {
        if (signal?.aborted) return;
        try {
          fn();
        } catch (error) {
          if (!signal?.aborted) failure = error;
          stop();
        }
      };
      const then: Then = (request, next) => {
        request.onsuccess = () => guard(() => next(request.result));
      };
      tx.oncomplete = () => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      tx.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(
          failure ?? tx.error ?? new Error("Artifact transaction aborted"),
        );
      };
      guard(() =>
        work(tx, then, (result) => {
          value = result;
        }),
      );
    });
  }
  function collection(
    owner: string,
    definition: ArtifactCollectionDefinition,
  ): HostArtifactCollection {
    if (closed) throw new Error("Artifact storage closed");
    if (
      !owner ||
      !definition.name ||
      !definition.type ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1
    )
      throw new Error("Invalid artifact collection");
    const collection = JSON.stringify([owner, definition.name]);
    const prefix = [scope, collection];
    const key = (id: string) => [...prefix, id];
    const range = (parts: IDBValidKey[]) =>
      IDBKeyRange.bound(parts, [...parts, []]);
    let disposed = false;
    const listeners = new Set<() => void>();
    const channel = new BroadcastChannel(`${DB}:${JSON.stringify(prefix)}`);
    const changed = () => {
      for (const listener of listeners)
        queueMicrotask(() => {
          if (!disposed && listeners.has(listener)) listener();
        });
    };
    channel.onmessage = changed;
    const publish = () => {
      if (!disposed) {
        changed();
        channel.postMessage(null);
      }
    };
    function reindex(
      tx: IDBTransaction,
      then: Then,
      row: Row,
      preference: JsonValue | undefined,
      next: () => void,
    ) {
      const entries = tx.objectStore("entries");
      then(
        entries.index("record").getAllKeys(IDBKeyRange.only(key(row.id))),
        (keys) => {
          for (const old of keys) entries.delete(old);
          for (const index of definition.project({
            record: row.record,
            ...(preference !== undefined ? { preference } : {}),
          })) {
            if (
              !index.index ||
              typeof index.value !== "string" ||
              typeof index.order !== "string"
            )
              throw new Error("Invalid artifact index entry");
            entries.put({ ...index, scope, collection, id: row.id });
          }
          next();
        },
      );
    }
    const ready = transact<void>("readwrite", (tx, then, done) => {
      const metadata = tx.objectStore("metadata");
      then(metadata.get(key("schema")), (schema) => {
        if (schema?.type && schema.type !== definition.type)
          throw new Error("Artifact collection type changed");
        if (schema?.version === definition.version) {
          done();
          return;
        }
        if (schema?.version > definition.version)
          throw new Error("Artifact collection requires a newer plugin");
        const request = tx.objectStore("records").openCursor(range(prefix));
        then(request, (cursor) => {
          if (!cursor) {
            metadata.put({
              scope,
              collection,
              key: "schema",
              version: definition.version,
              type: definition.type,
            });
            done();
            return;
          }
          then(
            tx.objectStore("preferences").get(key(cursor.value.id)),
            (pref: StoredPreference | undefined) =>
              reindex(tx, then, cursor.value, pref?.value, () =>
                cursor.continue(),
              ),
          );
        });
      });
    });
    // Keep an unopened handle's initialization rejection observable by its first operation.
    void ready.catch(() => {});
    async function run<T>(
      mode: IDBTransactionMode,
      work: Parameters<typeof transact<T>>[1],
      signal?: AbortSignal,
    ) {
      await ready;
      if (disposed) throw new Error("Artifact collection closed");
      return transact<T>(
        mode,
        (tx, then, done) => {
          then(tx.objectStore("metadata").get(key("schema")), (schema) => {
            if (schema?.version !== definition.version)
              throw new Error("Artifact collection version changed");
            work(tx, then, done);
          });
        },
        signal,
      );
    }
    function readEntry(
      tx: IDBTransaction,
      then: Then,
      id: string,
      done: (entry: ArtifactEntry | undefined) => void,
    ) {
      then(tx.objectStore("records").get(key(id)), (row: Row | undefined) => {
        if (!row) {
          done(undefined);
          return;
        }
        then(
          tx.objectStore("preferences").get(key(id)),
          (pref: StoredPreference | undefined) =>
            done({
              record: row.record,
              ...(pref ? { preference: pref.value } : {}),
            }),
        );
      });
    }
    function mutate(
      tx: IDBTransaction,
      then: Then,
      id: string,
      change: (
        row: Row,
        preference: JsonValue | undefined,
      ) => { row: Row; preference?: JsonValue },
      next: () => void,
    ) {
      if (!id) throw new Error("Artifact identity is empty");
      then(tx.objectStore("records").get(key(id)), (saved: Row | undefined) => {
        then(
          tx.objectStore("preferences").get(key(id)),
          (pref: StoredPreference | undefined) => {
            const result = change(
              saved ?? { ...emptyArtifact(id), scope, collection, id },
              pref?.value,
            );
            tx.objectStore("records").put(result.row);
            if (result.preference !== undefined)
              tx.objectStore("preferences").put({
                scope,
                collection,
                id,
                value: result.preference,
              });
            reindex(
              tx,
              then,
              result.row,
              result.preference !== undefined ? result.preference : pref?.value,
              next,
            );
          },
        );
      });
    }
    function series(items: readonly (() => void)[]) {
      let at = 0;
      return () => {
        items[at++]?.();
      };
    }
    const handle: HostArtifactCollection = {
      get: (id) =>
        run<ArtifactEntry | undefined>("readonly", (tx, then, done) =>
          readEntry(tx, then, id, done),
        ),
      page(query: ArtifactPageQuery) {
        const limit = query.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          return Promise.reject(
            new Error("Artifact page limit must be 1 to 1000"),
          );
        return run<ArtifactPage>("readonly", (tx, then, done) => {
          const pagePrefix = [...prefix, query.index, query.value];
          const lower = query.after
            ? [...pagePrefix, query.after.order, query.after.id]
            : pagePrefix;
          const request = tx
            .objectStore("entries")
            .openCursor(
              IDBKeyRange.bound(lower, [...pagePrefix, []], !!query.after),
            );
          const entries: ArtifactEntry[] = [];
          let last: { order: string; id: string } | undefined;
          then(request, function visit(cursor) {
            if (!cursor || entries.length === limit) {
              done({ entries, ...(cursor && last ? { next: last } : {}) });
              return;
            }
            const { id, order } = cursor.value;
            readEntry(tx, then, id, (entry) => {
              if (!entry) throw new Error("Artifact index has no record");
              entries.push(entry);
              last = { id, order };
              cursor.continue();
            });
          });
        });
      },
      subscribe(listener) {
        if (disposed) throw new Error("Artifact collection closed");
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      preferences: {
        get: (id) =>
          run<JsonValue | undefined>("readonly", (tx, then, done) =>
            then(
              tx.objectStore("preferences").get(key(id)),
              (pref: StoredPreference | undefined) => done(pref?.value),
            ),
          ),
        async update(id, change) {
          await run<void>("readwrite", (tx, then, done) =>
            mutate(
              tx,
              then,
              id,
              (row, current) => ({ row, preference: change(current) }),
              () => done(),
            ),
          );
          publish();
        },
      },
      async importBatch(batch: ArtifactImport) {
        await run<void>("readwrite", (tx, then, done) => {
          const jobs: (() => void)[] = [];
          const next = series(jobs);
          for (const record of batch.records ?? [])
            jobs.push(() =>
              mutate(
                tx,
                then,
                record.id,
                (row) => ({
                  row:
                    row.record.local !== undefined ||
                    row.record.current ||
                    row.heads.length
                      ? row
                      : {
                          ...row,
                          record: { ...row.record, local: record.local },
                        },
                }),
                next,
              ),
            );
          for (const pref of batch.preferences ?? [])
            jobs.push(() =>
              mutate(
                tx,
                then,
                pref.id,
                (row, current) => ({
                  row,
                  preference: current === undefined ? pref.value : current,
                }),
                next,
              ),
            );
          jobs.push(() => {
            if (batch.marker)
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: JSON.stringify(["import", batch.marker]),
                value: true,
              });
            done();
          });
          next();
        });
        publish();
      },
      imported: (marker) =>
        run<boolean>("readonly", (tx, then, done) =>
          then(
            tx
              .objectStore("metadata")
              .get(key(JSON.stringify(["import", marker]))),
            (row) => done(row?.value === true),
          ),
        ),
      checkpoint: () =>
        run<string | null>("readonly", (tx, then, done) =>
          then(tx.objectStore("metadata").get(key("checkpoint")), (row) =>
            done(row?.value ?? null),
          ),
        ),
      beginSnapshot(source) {
        if (!source)
          return Promise.reject(new Error("Artifact source is empty"));
        return run<ArtifactSnapshot>("readwrite", (tx, then, done) => {
          then(tx.objectStore("metadata").get(key("sequence")), (row) => {
            const snapshot = {
              source,
              generation: crypto.randomUUID(),
              captureSequence: row?.value ?? 0,
            };
            tx.objectStore("metadata").put({
              scope,
              collection,
              key: JSON.stringify(["snapshot", source]),
              value: snapshot,
            });
            done(snapshot);
          });
        });
      },
      async completeSnapshot(snapshot, checkpoint, signal) {
        await run<void>(
          "readwrite",
          (tx, then, done) => {
            const metadata = tx.objectStore("metadata");
            then(
              metadata.get(key(JSON.stringify(["snapshot", snapshot.source]))),
              (saved) => {
                if (!sameSnapshot(saved?.value, snapshot))
                  throw new Error("Artifact snapshot changed");
                then(metadata.get(key("checkpoint")), (row) => {
                  if ((row?.value ?? null) !== checkpoint.expected)
                    throw new Error("Artifact checkpoint changed");
                  const request = tx
                    .objectStore("members")
                    .openCursor(range([...prefix, snapshot.source]));
                  then(request, function visit(cursor) {
                    if (!cursor) {
                      metadata.put({
                        scope,
                        collection,
                        key: "checkpoint",
                        value: checkpoint.next,
                      });
                      metadata.delete(
                        key(JSON.stringify(["snapshot", snapshot.source])),
                      );
                      done();
                      return;
                    }
                    const member = cursor.value;
                    if (member.generation === snapshot.generation) {
                      cursor.continue();
                      return;
                    }
                    mutate(
                      tx,
                      then,
                      member.id,
                      (row) => ({
                        row:
                          (row.sequence ?? 0) > snapshot.captureSequence
                            ? row
                            : {
                                ...row,
                                record: {
                                  ...row.record,
                                  availability: {
                                    state: "unavailable",
                                    reason: "Absent from completed snapshot",
                                  },
                                },
                              },
                      }),
                      () => cursor.continue(),
                    );
                  });
                });
              },
            );
          },
          signal,
        );
        publish();
      },
      async applyBatch(batch: ArtifactBatch) {
        await run<void>("readwrite", (tx, then, done) => {
          const jobs: (() => void)[] = [];
          const next = series(jobs);
          let sequence = 0;
          if (!batch.source) throw new Error("Artifact source is empty");
          if (batch.snapshot)
            jobs.push(() => {
              const snapshot = batch.snapshot;
              if (!snapshot || snapshot.source !== batch.source)
                throw new Error("Artifact snapshot source mismatch");
              then(
                tx
                  .objectStore("metadata")
                  .get(key(JSON.stringify(["snapshot", batch.source]))),
                (row) => {
                  if (!sameSnapshot(row?.value, snapshot))
                    throw new Error("Artifact snapshot changed");
                  next();
                },
              );
            });
          jobs.push(() =>
            then(tx.objectStore("metadata").get(key("sequence")), (row) => {
              sequence = (row?.value ?? 0) + 1;
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: "sequence",
                value: sequence,
              });
              next();
            }),
          );
          jobs.push(() =>
            then(tx.objectStore("metadata").get(key("checkpoint")), (row) => {
              if (
                batch.checkpoint &&
                (row?.value ?? null) !== batch.checkpoint.expected
              )
                throw new Error("Artifact checkpoint changed");
              next();
            }),
          );
          for (const incoming of batch.records ?? [])
            jobs.push(() =>
              mutate(
                tx,
                then,
                incoming.id,
                (row) => {
                  if (row.record.type && row.record.type !== incoming.type)
                    throw new Error("Artifact type mismatch");
                  if (incoming.type !== definition.type)
                    throw new Error("Artifact type does not match collection");
                  tx.objectStore("members").put({
                    scope,
                    collection,
                    source: batch.source,
                    id: incoming.id,
                    generation: batch.snapshot?.generation ?? null,
                  });
                  const received = receiveRevision(row, incoming.revision);
                  if (
                    batch.snapshot &&
                    !row.superseded.includes(incoming.revision.id) &&
                    received.heads.some(
                      (head) => head.id === incoming.revision.id,
                    ) &&
                    (row.sequence ?? 0) <= batch.snapshot.captureSequence
                  ) {
                    if (
                      row.record.current &&
                      row.record.current.id !== incoming.revision.id
                    )
                      received.superseded = [
                        ...new Set([
                          ...received.superseded,
                          row.record.current.id,
                        ]),
                      ];
                    received.record = {
                      ...received.record,
                      current: incoming.revision,
                      conflicts: received.heads.filter(
                        (head) => head.id !== incoming.revision.id,
                      ),
                    };
                  }
                  return {
                    row: {
                      ...row,
                      ...received,
                      sequence: batch.snapshot ? row.sequence : sequence,
                      record: {
                        ...received.record,
                        ...(received.record.current?.id === incoming.revision.id
                          ? { channelId: incoming.channelId }
                          : {}),
                        type: incoming.type,
                      },
                    },
                  };
                },
                next,
              ),
            );
          for (const seen of batch.seen ?? [])
            jobs.push(() => {
              if (!batch.snapshot)
                throw new Error("Seen members require a snapshot");
              then(
                tx.objectStore("records").get(key(seen.id)),
                (row: Row | undefined) => {
                  if (!row || !Object.hasOwn(row.ancestry, seen.revisionId))
                    throw new Error("Snapshot revision is not saved");
                  tx.objectStore("members").put({
                    scope,
                    collection,
                    source: batch.source,
                    id: seen.id,
                    generation: batch.snapshot?.generation,
                  });
                  next();
                },
              );
            });
          for (const availability of batch.availability ?? [])
            jobs.push(() =>
              mutate(
                tx,
                then,
                availability.id,
                (row) => ({
                  row:
                    (row.record.current?.id ?? null) !==
                      availability.expectedRevision ||
                    (batch.snapshot &&
                      (row.sequence ?? 0) > batch.snapshot.captureSequence)
                      ? row
                      : {
                          ...row,
                          sequence: batch.snapshot ? row.sequence : sequence,
                          record: {
                            ...row.record,
                            availability: availability.value,
                          },
                        },
                }),
                next,
              ),
            );
          jobs.push(() => {
            if (batch.checkpoint)
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: "checkpoint",
                value: batch.checkpoint.next,
              });
            done();
          });
          next();
        });
        publish();
      },
      close() {
        disposed = true;
        listeners.clear();
        channel.close();
        collections.delete(handle);
      },
    };
    collections.add(handle);
    return handle;
  }
  return {
    collection,
    async clear() {
      await transact<void>("readwrite", (tx, then, done) => {
        let pending = STORES.length;
        for (const name of STORES) {
          const request = tx
            .objectStore(name)
            .openCursor(IDBKeyRange.bound([scope], [scope, []]));
          then(request, function visit(cursor) {
            if (!cursor) {
              if (--pending === 0) done();
              return;
            }
            cursor.delete();
            cursor.continue();
          });
        }
      });
    },
    close() {
      closed = true;
      for (const handle of collections) handle.close();
      void opening?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
export type ArtifactStore = ReturnType<typeof createArtifactStore>;

export async function purgeArtifactStorage(viewer: string, relay: string) {
  if (typeof indexedDB === "undefined") return;
  const store = createArtifactStore(viewer, relay);
  try {
    await store.clear();
  } finally {
    store.close();
  }
}
