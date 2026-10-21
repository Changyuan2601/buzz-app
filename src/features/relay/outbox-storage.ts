import type { OutboxStorage, OutgoingEvent } from "./outbox";
import { mergeManagedDelivery } from "./managed-delivery";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-outbox-v2", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("partitions"))
        db.createObjectStore("partitions");
      if (!db.objectStoreNames.contains("events"))
        db.createObjectStore("events", {
          keyPath: ["scope", "id"],
        }).createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to upgrade the outbox"));
  });
}

/** Drops one partition's journal, including its legacy record, after that
 * community's session is disposed: nothing left there can still be delivered. */
export async function purgeOutboxStorage(scope: string) {
  localStorage.removeItem(`buzz-outbox-v1:${scope}`);
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["events", "partitions"], "readwrite", {
        durability: "strict",
      });
      const events = tx.objectStore("events");
      const keys = events.index("scope").getAllKeys(IDBKeyRange.only(scope));
      keys.onsuccess = () => {
        for (const key of keys.result) events.delete(key);
      };
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Outbox purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Incremental asynchronous journal, atomically partitioned by relay and viewer. */
export function browserOutboxStorage(scope: string): OutboxStorage {
  let database: Promise<IDBDatabase> | undefined;
  let persisted = new Map<string, OutgoingEvent>();
  const open = () =>
    (database ??= openDatabase().catch((error) => {
      database = undefined;
      throw error;
    }));
  const listeners = new Set<() => void>();
  const changes =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(`buzz-outbox:${scope}`);
  if (changes)
    changes.onmessage = () => {
      for (const listener of listeners) listener();
    };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(options) {
      const db = await open();
      let migrated = false;
      const records = await new Promise<readonly OutgoingEvent[]>(
        (resolve, reject) => {
          const tx = db.transaction(["events", "partitions"]);
          const entries = tx
            .objectStore("events")
            .index("scope")
            .getAll(IDBKeyRange.only(scope));
          const legacy = tx.objectStore("partitions").get(scope);
          tx.oncomplete = () => {
            try {
              migrated = legacy.result === true;
              const values = entries.result.map(
                (entry: { operation: OutgoingEvent }) => entry.operation,
              );
              // The marker distinguishes a migrated empty journal from an un-migrated one.
              resolve(
                values.length || legacy.result === true
                  ? values
                  : (legacy.result ??
                      JSON.parse(
                        localStorage.getItem(`buzz-outbox-v1:${scope}`) ?? "[]",
                      )),
              );
            } catch (error) {
              reject(error);
            }
          };
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        },
      );
      // A first save migrates legacy records into the per-event store.
      if (!options?.refresh)
        persisted = migrated
          ? new Map(records.map((item) => [item.event.id, item]))
          : new Map();
      return records;
    },
    async save(operations) {
      const db = await open();
      const next = new Map(operations.map((item) => [item.event.id, item]));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["events", "partitions"], "readwrite", {
          durability: "strict",
        });
        const events = tx.objectStore("events");
        for (const [id, operation] of next) {
          const old = persisted.get(id);
          if (
            old &&
            old.delivery === operation.delivery &&
            old.error === operation.error &&
            old.refused === operation.refused &&
            old.acknowledged === operation.acknowledged &&
            old.signed?.id === operation.signed?.id &&
            old.recovery?.key === operation.recovery?.key &&
            old.recovery?.value === operation.recovery?.value &&
            old.guarded === operation.guarded &&
            JSON.stringify(old.managed) === JSON.stringify(operation.managed)
          )
            continue;
          if (operation.managed) {
            const current = events.get([scope, id]);
            current.onsuccess = () => {
              try {
                const prior = current.result?.operation as
                  | OutgoingEvent
                  | undefined;
                const managed =
                  prior?.managed && operation.managed
                    ? mergeManagedDelivery(prior.managed, operation.managed)
                    : operation.managed;
                events.put({ scope, id, operation: { ...operation, managed } });
              } catch {
                tx.abort();
              }
            };
          } else events.put({ scope, id, operation });
        }
        for (const id of persisted.keys())
          if (!next.has(id)) events.delete([scope, id]);
        tx.objectStore("partitions").put(true, scope);
        tx.oncomplete = () => {
          persisted = next;
          changes?.postMessage(null);
          resolve();
        };
        tx.onabort = () =>
          reject(tx.error ?? new Error("Outbox transaction aborted"));
        tx.onerror = () => reject(tx.error);
      });
    },
    close() {
      changes?.close();
      listeners.clear();
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
