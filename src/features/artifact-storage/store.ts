import type { JsonValue } from "../navigation/targets";
import { relayPartition } from "../relay/partition";
import type {
  ArtifactBatch,
  ArtifactCollectionDefinition,
  ArtifactEntry,
  ArtifactImport,
  ArtifactPage,
  ArtifactPageQuery,
  HostArtifactCollection,
  ArtifactSnapshot,
  SavedArtifact,
} from "./types";

const DB = "buzz-artifacts-v1";
const STORES = ["records", "preferences", "entries", "metadata"];
type Row = {
  record: SavedArtifact;
  scope: string;
  collection: string;
  id: string;
  generation?: string;
};
type StoredPreference = { value: JsonValue };

function sameSnapshot(
  left: ArtifactSnapshot | undefined,
  right: ArtifactSnapshot,
) {
  return left?.source === right.source && left.generation === right.generation;
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
    if (!opening) {
      const attempt = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB, 2);
        let blocked = false;
        request.onupgradeneeded = () => {
          const db = request.result;
          if (db.objectStoreNames.contains("members"))
            db.deleteObjectStore("members");
          for (const name of STORES) {
            if (db.objectStoreNames.contains(name)) continue;
            const store = db.createObjectStore(name, {
              keyPath:
                name === "entries"
                  ? ["scope", "collection", "index", "value", "order", "id"]
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
          reject(
            new Error("Close other Buzz windows to open artifact storage"),
          );
        };
        request.onsuccess = () => {
          const db = request.result;
          if (closed || blocked) {
            db.close();
            reject(new Error("Artifact storage closed"));
            return;
          }
          db.onversionchange = () => {
            db.close();
            opening = undefined;
          };
          resolve(db);
        };
      });
      opening = attempt;
      void attempt.catch(() => {
        if (opening === attempt) opening = undefined;
      });
    }
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
    const lifetime = new AbortController();
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
    const ready = transact<void>(
      "readwrite",
      (tx, then, done) => {
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
          metadata.delete(key("source"));
          metadata.delete(key("snapshot"));
          metadata.delete(key("checkpoint"));
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
      },
      lifetime.signal,
    );
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
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      );
    }
    function bindSource(
      tx: IDBTransaction,
      then: Then,
      source: string,
      next: () => void,
    ) {
      if (!source) throw new Error("Artifact source is empty");
      const metadata = tx.objectStore("metadata");
      then(metadata.get(key("source")), (saved) => {
        if (saved && saved.value !== source)
          throw new Error("Artifact collection query changed");
        if (!saved)
          metadata.put({ scope, collection, key: "source", value: source });
        next();
      });
    }
    function checkSnapshot(
      tx: IDBTransaction,
      then: Then,
      snapshot: ArtifactSnapshot,
      next: () => void,
    ) {
      bindSource(tx, then, snapshot.source, () => {
        then(tx.objectStore("metadata").get(key("snapshot")), (saved) => {
          if (!sameSnapshot(saved?.value, snapshot))
            throw new Error("Artifact snapshot changed");
          next();
        });
      });
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
              saved ?? {
                record: { id, availability: { state: "unknown" } },
                scope,
                collection,
                id,
              },
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
      scope: Object.freeze({ viewer, relay, partition: scope }),
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
                    row.record.local !== undefined || row.record.current
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
      refreshError: () =>
        run<string | null>("readonly", (tx, then, done) =>
          then(tx.objectStore("metadata").get(key("refresh-error")), (row) =>
            done(row?.value ?? null),
          ),
        ),
      async setRefreshError(snapshot, message, signal) {
        if (!message) throw new Error("Artifact refresh error is empty");
        await run<void>(
          "readwrite",
          (tx, then, done) => {
            checkSnapshot(tx, then, snapshot, () => {
              tx.objectStore("metadata").put({
                scope,
                collection,
                key: "refresh-error",
                value: message,
              });
              done();
            });
          },
          signal,
        );
        publish();
      },
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
          bindSource(tx, then, source, () => {
            const snapshot = { source, generation: crypto.randomUUID() };
            tx.objectStore("metadata").put({
              scope,
              collection,
              key: "snapshot",
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
            checkSnapshot(tx, then, snapshot, () => {
              const metadata = tx.objectStore("metadata");
              then(metadata.get(key("checkpoint")), (row) => {
                if ((row?.value ?? null) !== checkpoint.expected)
                  throw new Error("Artifact checkpoint changed");
                const request = tx
                  .objectStore("records")
                  .openCursor(range(prefix));
                then(request, function visit(cursor) {
                  if (!cursor) {
                    metadata.put({
                      scope,
                      collection,
                      key: "checkpoint",
                      value: checkpoint.next,
                    });
                    metadata.delete(key("snapshot"));
                    metadata.delete(key("refresh-error"));
                    done();
                    return;
                  }
                  const saved: Row = cursor.value;
                  if (
                    !saved.record.current ||
                    saved.generation === snapshot.generation ||
                    saved.record.availability.state === "unavailable"
                  ) {
                    cursor.continue();
                    return;
                  }
                  mutate(
                    tx,
                    then,
                    saved.id,
                    (row) => ({
                      row: {
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
            });
          },
          signal,
        );
        publish();
      },
      async applyBatch(batch: ArtifactBatch, signal) {
        await run<void>(
          "readwrite",
          (tx, then, done) => {
            const jobs: (() => void)[] = [];
            const next = series(jobs);
            if (!batch.snapshot || batch.source !== batch.snapshot.source)
              throw new Error("Artifact snapshot source mismatch");
            jobs.push(() => checkSnapshot(tx, then, batch.snapshot, next));
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
                    if (incoming.type !== definition.type)
                      throw new Error(
                        "Artifact type does not match collection",
                      );
                    if (
                      !incoming.channelId ||
                      !incoming.revision.id ||
                      typeof incoming.revision.content !== "string"
                    )
                      throw new Error("Invalid authoritative artifact");
                    return {
                      row: {
                        scope,
                        collection,
                        id: incoming.id,
                        generation: batch.snapshot.generation,
                        record: {
                          id: incoming.id,
                          channelId: incoming.channelId,
                          type: incoming.type,
                          current: incoming.revision,
                          availability: row.record.availability,
                          ...(row.record.local !== undefined
                            ? { local: row.record.local }
                            : {}),
                        },
                      },
                    };
                  },
                  next,
                ),
              );
            for (const seen of batch.seen ?? [])
              jobs.push(() =>
                then(
                  tx.objectStore("records").get(key(seen.id)),
                  (row: Row | undefined) => {
                    if (!row || row.record.current?.id !== seen.revisionId)
                      throw new Error("Snapshot revision is not saved");
                    tx.objectStore("records").put({
                      ...row,
                      generation: batch.snapshot.generation,
                    });
                    next();
                  },
                ),
              );
            for (const availability of batch.availability ?? [])
              jobs.push(() =>
                mutate(
                  tx,
                  then,
                  availability.id,
                  (row) => {
                    if (
                      (row.record.current?.id ?? null) !==
                      availability.expectedRevision
                    )
                      throw new Error("Artifact revision changed");
                    return {
                      row: {
                        ...row,
                        record: {
                          ...row.record,
                          availability: availability.value,
                        },
                      },
                    };
                  },
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
          },
          signal,
        );
        publish();
      },
      close() {
        lifetime.abort(new Error("Artifact collection closed"));
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
      const affected = new Set<string>();
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
            affected.add(cursor.value.collection);
            cursor.delete();
            cursor.continue();
          });
        }
      });
      for (const collection of affected) {
        const channel = new BroadcastChannel(
          `${DB}:${JSON.stringify([scope, collection])}`,
        );
        channel.postMessage(null);
        channel.close();
      }
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
