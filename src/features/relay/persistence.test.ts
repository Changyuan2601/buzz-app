import { afterEach, expect, it, vi } from "vitest";
import { createHeadPersistence, type HeadPersistence } from "./persistence";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Store = Partial<IDBObjectStore>;
function transaction(
  abort: () => void,
  run: (cache: HeadPersistence) => Promise<unknown> = (cache) =>
    cache.remove("channel"),
  store: Store = { delete: vi.fn() },
) {
  const tx = {
    abort: vi.fn(abort),
    error: null,
    oncomplete: () => {},
    onabort: () => {},
    onerror: () => {},
    objectStore: () => store,
  };
  const request = {
    onsuccess: () => {},
    result: { transaction: () => tx, close: vi.fn() },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const cache = createHeadPersistence("viewer", "relay");
  const result = run(cache);
  request.onsuccess();
  return { tx, result };
}

it("waits for completion when a timeout races an already-finished transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => {
    throw new DOMException("The transaction has finished", "InvalidStateError");
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("still aborts and rejects a genuinely stalled transaction", async () => {
  vi.useFakeTimers();
  const { tx, result } = transaction(() => tx.onabort());
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects unexpected abort errors instead of leaving the operation pending", async () => {
  vi.useFakeTimers();
  const failure = new Error("Unexpected abort failure");
  const { result } = transaction(() => {
    throw failure;
  });
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});

function inactivating() {
  const state = { active: true };
  const get = { onsuccess: () => {}, result: undefined };
  const store: Store = {
    get: vi.fn(() => get as unknown as IDBRequest),
    getAll: vi.fn(),
    put: vi.fn(() => {
      if (state.active) return {} as IDBRequest<IDBValidKey>;
      throw new DOMException(
        "Failed to store record in an IDBObjectStore: The transaction is inactive or finished.",
        "TransactionInactiveError",
      );
    }),
  };
  return { state, get, store };
}
const writeStartup = (cache: HeadPersistence) =>
  cache.writeStartup?.({}) ?? Promise.reject();

it("ignores a request result delivered after the timeout aborted its transaction", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(
    () => {
      state.active = false;
    },
    writeStartup,
    store,
  );
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(2000);
  expect(tx.abort).toHaveBeenCalledOnce();
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("swallows a follow-up request thrown by a browser-initiated abort", async () => {
  vi.useFakeTimers();
  const { state, get, store } = inactivating();
  const { tx, result } = transaction(() => {}, writeStartup, store);
  const rejected = expect(result).rejects.toThrow("Cache transaction aborted");
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get).toHaveBeenCalledOnce();
  state.active = false;
  expect(() => get.onsuccess()).not.toThrow();
  expect(store.put).toHaveBeenCalledOnce();
  expect(store.getAll).not.toHaveBeenCalled();
  tx.onabort();
  await rejected;
  expect(tx.abort).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("evicts the same heads from key-only budget entries as from full records", async () => {
  const now = Date.now();
  const saved = new Map<string, { savedAt: number; bytes: number }>();
  // Ties on savedAt, an expired head, and more heads and bytes than allowed.
  for (const i of [...Array(70).keys()].sort(
    (a, b) => ((a * 37) % 70) - ((b * 37) % 70),
  ))
    saved.set(`scope:${String.fromCharCode(97 + (i % 26))}${i}`, {
      savedAt: i === 5 ? now - 25 * 3600_000 : now - Math.floor(i / 3) * 1000,
      bytes: 150_000 + (i % 4) * 10_000,
    });
  const deleted: string[] = [];
  const cursor = { onsuccess: () => {}, result: null as unknown };
  const store: Store = {
    put: vi.fn((row: { key: string; savedAt: number; bytes: number }) => {
      saved.set(row.key, row);
      return {} as IDBRequest<IDBValidKey>;
    }),
    delete: vi.fn((key) => {
      deleted.push(String(key));
      return {} as IDBRequest<undefined>;
    }),
    index: vi.fn(() => {
      const entries = [...saved]
        .map(([key, { savedAt, bytes }]) => ({ key, savedAt, bytes }))
        .sort(
          (a, b) =>
            a.savedAt - b.savedAt ||
            a.bytes - b.bytes ||
            (a.key < b.key ? -1 : 1),
        );
      const next = () =>
        queueMicrotask(() => {
          const entry = entries.shift();
          cursor.result = entry && {
            key: [entry.savedAt, entry.bytes],
            primaryKey: entry.key,
            continue: next,
          };
          cursor.onsuccess();
        });
      next();
      return {
        openKeyCursor: () => cursor as unknown as IDBRequest,
      } as unknown as IDBIndex;
    }),
  };
  const head = { channelId: "new", savedAt: now, events: [], profiles: [] };
  const { tx, result } = transaction(
    () => {},
    (cache) => cache.write(head),
    store,
  );
  await vi.waitFor(() => expect(cursor.result).toBeUndefined());
  // What the budget pass did when it read every record with getAll().
  const expected: string[] = [];
  let total = 0,
    count = 0;
  const rows = [...saved]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .sort((a, b) => b.savedAt - a.savedAt);
  for (const entry of rows) {
    total += entry.bytes;
    count++;
    if (
      total > 8 * 1024 * 1024 ||
      count > 64 ||
      Date.now() - entry.savedAt >= 24 * 3600_000
    )
      expected.push(entry.key);
  }
  expect(expected.length).toBeGreaterThan(6);
  expect(deleted).toEqual(expected);
  tx.oncomplete();
  await expect(result).resolves.toBeUndefined();
});
