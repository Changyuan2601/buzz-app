import { fileURLToPath } from "node:url";
import { test as base, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

const test = base.extend({
  storageUrl: [
    async ({ browserName }, use) => {
      if (!["chromium", "webkit"].includes(browserName))
        throw new Error("Unsupported storage test engine");
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envDir: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      try {
        await use(
          `${server.resolvedUrls.local[0]}tests/fixtures/artifact-storage.html`,
        );
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});
async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.artifactTest);
}

// Real IndexedDB completion, restart and BroadcastChannel cannot be proved in a DOM emulator.
test("commits across windows and survives offline restart with isolated scopes", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  await other.evaluate(async () => {
    window.collection = window.artifactTest.open();
    await window.collection.get("task");
    window.change = new Promise((resolve) => {
      window.collection.subscribe(async () =>
        resolve(await window.collection.get("task")),
      );
    });
  });
  await page.evaluate(async () => {
    const collection = window.artifactTest.open();
    await collection.importBatch({
      records: [{ id: "task", local: { title: "saved" } }],
      preferences: [{ id: "task", value: { pinned: false } }],
      marker: "done",
    });
  });
  expect((await other.evaluate(() => window.change)).preference).toEqual({
    pinned: false,
  });
  await other.evaluate(() => {
    window.errorChange = new Promise((resolve) => {
      const stop = window.collection.subscribe(async () => {
        const error = await window.collection.refreshError();
        if (error) {
          stop();
          resolve(error);
        }
      });
    });
  });
  await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const snapshot = await c.beginSnapshot("all");
    await c.setRefreshError(snapshot, "Refresh unavailable");
  });
  expect(await other.evaluate(() => window.errorChange)).toBe(
    "Refresh unavailable",
  );
  await page.reload();
  await page.waitForFunction(() => !!window.artifactTest);
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const collection = window.artifactTest.open();
    return {
      row: await collection.get("task"),
      marker: await collection.imported("done"),
      refreshError: await collection.refreshError(),
      identities: await window.artifactTest.open("other").get("task"),
      relays: await window.artifactTest.open("viewer", "other").get("task"),
      plugins: await window.artifactTest
        .open("viewer", "relay", "other")
        .get("task"),
      collections: await window.artifactTest
        .open("viewer", "relay", "test", { name: "other" })
        .get("task"),
    };
  });
  expect(result.row.record.local).toEqual({ title: "saved" });
  expect(result.marker).toBe(true);
  expect(result.refreshError).toBe("Refresh unavailable");
  for (const field of ["identities", "relays", "plugins", "collections"])
    expect(result[field]).toBeUndefined();
});

test("rolls back received batches and migration failures without publishing changes", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const notices = [];
    c.subscribe(() => notices.push("change"));
    const records = [
      {
        id: "good",
        channelId: "channel",
        type: "test.task",
        revision: { id: "a", content: "{}" },
      },
      {
        id: "bad",
        channelId: "",
        type: "test.task",
        revision: { id: "bad", content: "{}" },
      },
    ];
    const failure = await c
      .applyBatch({
        source: "all",
        snapshot: await c.beginSnapshot("all"),
        records,
        checkpoint: { expected: null, next: "bad" },
      })
      .then(
        () => "unexpected",
        (error) => error.message,
      );
    const after = await c.get("good");
    const checkpoint = await c.checkpoint();
    const failing = window.artifactTest.open("viewer", "relay", "test", {
      name: "migration",
      project: () => {
        throw new Error("projection failed");
      },
    });
    const migration = await failing
      .importBatch({
        records: [{ id: "one", local: {} }],
        preferences: [{ id: "one", value: false }],
        marker: "done",
      })
      .then(
        () => "unexpected",
        (error) => error.message,
      );
    return {
      failure,
      after,
      checkpoint,
      notices,
      migration,
      imported: await failing.imported("done"),
      pref: await failing.preferences.get("one"),
    };
  });
  expect(result).toEqual({
    failure: "Invalid authoritative artifact",
    after: undefined,
    checkpoint: null,
    notices: [],
    migration: "projection failed",
    imported: false,
    pref: undefined,
  });
});

test("atomically indexes preference changes and preserves newer values during migration retries", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  await page.evaluate(async () => {
    window.collection = window.artifactTest.open();
    await window.collection.importBatch({
      records: [{ id: "task", local: { archived: false } }],
      preferences: [{ id: "task", value: { pinned: true } }],
    });
  });
  await other.evaluate(async () => {
    const c = window.artifactTest.open();
    await c.preferences.update("task", () => ({
      archived: true,
      pinned: false,
    }));
  });
  const result = await page.evaluate(async () => {
    const c = window.collection;
    await c.importBatch({
      records: [{ id: "task", local: { lost: true } }],
      preferences: [{ id: "task", value: { pinned: true } }],
      marker: "done",
    });
    return {
      archived: await c.page({ index: "archive", value: "true" }),
      active: await c.page({ index: "archive", value: "false" }),
      row: await c.get("task"),
    };
  });
  expect(result.active.entries).toHaveLength(0);
  expect(result.archived.entries).toHaveLength(1);
  expect(result.row.preference).toEqual({ archived: true, pinned: false });
  expect(result.row.record.local).toEqual({ archived: false });
});

test("reconciles one fixed query only after completion and preserves device data", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id) => ({
      id,
      channelId: "channel",
      type: "test.task",
      revision: { id, content: "{}" },
    });
    const seed = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      snapshot: seed,
      records: [record("missing"), record("seen")],
      availability: ["missing", "seen"].map((id) => ({
        id,
        expectedRevision: id,
        value: { state: "available" },
      })),
    });
    await c.completeSnapshot(seed, { expected: null, next: "seed" });
    await c.preferences.update("missing", () => ({ pinned: false }));
    await c.importBatch({
      records: [{ id: "device-only", local: { title: "saved" } }],
    });
    const partial = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      snapshot: partial,
      seen: [{ id: "seen", revisionId: "seen" }],
    });
    await c.setRefreshError(partial, "Refresh limit reached");
    const before = await c.get("missing");
    const error = await c.refreshError();
    const snapshot = await c.beginSnapshot("all");
    const retainedError = await c.refreshError();
    const stale = await c
      .completeSnapshot(partial, { expected: "seed", next: "wrong" })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const wrongQuery = await c.beginSnapshot("other").then(
      () => "unexpected",
      (e) => e.message,
    );
    await c.applyBatch({
      source: "all",
      snapshot,
      seen: [{ id: "seen", revisionId: "seen" }],
    });
    await c.completeSnapshot(snapshot, { expected: "seed", next: "complete" });
    const lateError = await c.setRefreshError(partial, "old error").then(
      () => "unexpected",
      (e) => e.message,
    );
    return {
      before,
      error,
      retainedError,
      stale,
      wrongQuery,
      lateError,
      missing: await c.get("missing"),
      seen: await c.get("seen"),
      local: await c.get("device-only"),
      checkpoint: await c.checkpoint(),
      clearedError: await c.refreshError(),
    };
  });
  expect(result.before.record.availability.state).toBe("available");
  expect(result.error).toBe("Refresh limit reached");
  expect(result.retainedError).toBe(result.error);
  expect(result.stale).toBe("Artifact snapshot changed");
  expect(result.wrongQuery).toBe("Artifact collection query changed");
  expect(result.lateError).toBe("Artifact snapshot changed");
  expect(result.missing.record.availability.state).toBe("unavailable");
  expect(result.missing.record.current.content).toBe("{}");
  expect(result.missing.preference).toEqual({ pinned: false });
  expect(result.seen.record.availability.state).toBe("available");
  expect(result.local.record.local).toEqual({ title: "saved" });
  expect(result.checkpoint).toBe("complete");
  expect(result.clearedError).toBeNull();
});

test("reads bounded indexed pages for 10,000 tasks and 40,000 archived records", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const start = performance.now();
    for (let offset = 0; offset < 50000; offset += 1000) {
      await c.importBatch({
        records: Array.from({ length: 1000 }, (_, n) => ({
          id: String(offset + n).padStart(6, "0"),
          local: { archived: offset + n >= 10000 },
        })),
      });
    }
    const savedMs = performance.now() - start;
    let reads = 0;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.name === "records") reads++;
      return get.apply(this, args);
    };
    const begin = performance.now();
    const first = await c.page({ index: "archive", value: "false", limit: 75 });
    const second = await c.page({
      index: "archive",
      value: "false",
      limit: 75,
      after: first.next,
    });
    const archive = await c.page({
      index: "archive",
      value: "true",
      limit: 75,
    });
    const elapsedMs = performance.now() - begin;
    IDBObjectStore.prototype.get = get;
    window.artifactTest.close();
    const reopened = window.artifactTest.open();
    return {
      savedMs,
      elapsedMs,
      reads,
      first: first.entries.map((e) => e.record.id),
      second: second.entries.map((e) => e.record.id),
      archive: archive.entries.map((e) => e.record.id),
      last: (await reopened.get("049999")).record.local,
    };
  });
  expect(result.first).toHaveLength(75);
  expect(result.second[0]).toBe("000075");
  expect(result.archive[0]).toBe("010000");
  expect(result.reads).toBe(225);
  expect(result.last).toEqual({ archived: true });
  console.log(
    JSON.stringify({
      engine: test.info().project.name,
      savedMs: result.savedMs,
      pageMs: result.elapsedMs,
      recordReads: result.reads,
    }),
  );
});

test("accepts authoritative heads without ancestry and rejects retired captures", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id, channelId) => ({
      id: "task",
      channelId,
      type: "test.task",
      revision: { id, content: "{}" },
    });
    const old = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      snapshot: old,
      records: [record("A", "old-home")],
    });
    const newer = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      snapshot: newer,
      records: [record("C", "new-home")],
      availability: [
        { id: "task", expectedRevision: "C", value: { state: "available" } },
      ],
    });
    const stale = await c
      .applyBatch({
        source: "all",
        snapshot: old,
        records: [record("A", "old-home")],
      })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const revision = await c
      .applyBatch({
        source: "all",
        snapshot: newer,
        availability: [
          { id: "task", expectedRevision: "A", value: { state: "deleted" } },
        ],
      })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const mismatch = await c
      .applyBatch({ source: "other", snapshot: newer })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const raw = await c
      .applyBatch({ source: "all", records: [record("raw-live", "bad-home")] })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    const notSaved = await c
      .applyBatch({
        source: "all",
        snapshot: newer,
        seen: [{ id: "task", revisionId: "A" }],
      })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    await c.completeSnapshot(newer, { expected: null, next: "done" });
    return {
      stale,
      revision,
      mismatch,
      raw,
      notSaved,
      row: await c.get("task"),
    };
  });
  expect(result.stale).toBe("Artifact snapshot changed");
  expect(result.revision).toBe("Artifact revision changed");
  expect(result.mismatch).toBe("Artifact snapshot source mismatch");
  expect(result.raw).toBe("Artifact snapshot source mismatch");
  expect(result.notSaved).toBe("Snapshot revision is not saved");
  expect(result.row.record.current.id).toBe("C");
  expect(result.row.record.channelId).toBe("new-home");
  expect(result.row.record.availability.state).toBe("available");
  expect(result.row.record).not.toHaveProperty("unresolved");
  expect(result.row.record).not.toHaveProperty("conflicts");
});

test("aborts snapshot completion before and during the local transaction", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    let controller;
    let abortOnProjection = false;
    let closeOnProjection = false;
    const c = window.artifactTest.open("viewer", "relay", "test", {
      project() {
        if (abortOnProjection)
          controller.abort(new Error("live interval lost"));
        if (closeOnProjection) c.close();
        return [];
      },
    });
    await c.applyBatch({
      source: "all",
      snapshot: await c.beginSnapshot("all"),
      records: [
        {
          id: "task",
          channelId: "channel",
          type: "test.task",
          revision: { id: "A", content: "{}" },
        },
      ],
      availability: [
        { id: "task", expectedRevision: "A", value: { state: "available" } },
      ],
    });
    const snapshot = await c.beginSnapshot("all");
    const pre = new AbortController();
    pre.abort(new Error("owner closed"));
    const before = await c
      .completeSnapshot(snapshot, { expected: null, next: "bad" }, pre.signal)
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    controller = new AbortController();
    abortOnProjection = true;
    const during = await c
      .completeSnapshot(
        snapshot,
        { expected: null, next: "bad" },
        controller.signal,
      )
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    controller = new AbortController();
    const batch = await c
      .applyBatch(
        {
          source: "all",
          snapshot,
          records: [
            {
              id: "task",
              channelId: "new-home",
              type: "test.task",
              revision: { id: "B", content: "{}" },
            },
          ],
        },
        controller.signal,
      )
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    abortOnProjection = false;
    const row = await c.get("task");
    const checkpoint = await c.checkpoint();
    closeOnProjection = true;
    const closed = await c
      .completeSnapshot(snapshot, { expected: null, next: "closed" })
      .then(
        () => "unexpected",
        (e) => e.message,
      );
    return {
      before,
      batch,
      closed,
      row,
      checkpoint,
      during,
    };
  });
  expect(result.before).toBe("owner closed");
  expect(result.during).toBe("live interval lost");
  expect(result.batch).toBe("live interval lost");
  expect(result.closed).toBe("Artifact collection closed");
  expect(result.row.record.current.id).toBe("A");
  expect(result.row.record.availability.state).toBe("available");
  expect(result.checkpoint).toBeNull();
});

test("upgrades across windows and rejects stale writes and snapshot completion", async ({
  page,
  context,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const other = await context.newPage();
  await open(other, storageUrl);
  const snapshot = await other.evaluate(async () => {
    window.collection = window.artifactTest.open();
    await window.collection.importBatch({
      records: [{ id: "task", local: {} }],
      preferences: [{ id: "task", value: true }],
    });
    return window.collection.beginSnapshot("all");
  });
  const result = await page.evaluate(async () => {
    const newer = window.artifactTest.open("viewer", "relay", "test", {
      version: 2,
      project: ({ preference }) => [
        { index: "value", value: JSON.stringify(preference), order: "" },
      ],
    });
    window.collection = newer;
    await newer.preferences.update("task", () => null);
    const page = await newer.page({ index: "value", value: "null" });
    const older = window.artifactTest.open();
    const downgrade = await older.get("task").then(
      () => "unexpected",
      (e) => e.message,
    );
    const incompatible = window.artifactTest.open("viewer", "relay", "test", {
      version: 2,
      type: "other.task",
    });
    const type = await incompatible.get("task").then(
      () => "unexpected",
      (e) => e.message,
    );
    return { page, downgrade, type };
  });
  const stale = await other.evaluate(async (snapshot) => {
    const error = (e) => e.message;
    return Promise.all([
      window.collection.preferences
        .update("task", () => false)
        .then(() => "unexpected", error),
      window.collection
        .completeSnapshot(snapshot, { expected: null, next: "stale" })
        .then(() => "unexpected", error),
    ]);
  }, snapshot);
  expect(result.page.entries[0].preference).toBeNull();
  expect(stale).toEqual([
    "Artifact collection version changed",
    "Artifact collection version changed",
  ]);
  expect(result.downgrade).toBe("Artifact collection requires a newer plugin");
  expect(result.type).toBe("Artifact collection type changed");
  expect(
    await page.evaluate(async () => {
      const c = window.collection;
      return {
        preference: await c.preferences.get("task"),
        checkpoint: await c.checkpoint(),
      };
    }),
  ).toEqual({ preference: null, checkpoint: null });
});

test("purges one identity and relay across collections", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const { createArtifactStore, purgeArtifactStorage } = await import(
      "/src/features/artifact-storage/store.ts"
    );
    const definition = {
      name: "one",
      type: "test.task",
      version: 1,
      project: () => [],
    };
    const first = createArtifactStore("viewer", "relay");
    const other = createArtifactStore("other", "relay");
    for (const c of [
      first.collection("test", definition),
      first.collection("test", { ...definition, name: "two" }),
      other.collection("test", definition),
    ]) {
      await c.importBatch({
        records: [{ id: "task", local: {} }],
        preferences: [{ id: "task", value: false }],
        marker: "done",
      });
    }
    first.close();
    other.close();
    const observer = createArtifactStore("viewer", "relay");
    const observed = observer.collection("test", definition);
    await observed.get("task");
    const notification = new Promise((resolve) => observed.subscribe(resolve));
    await purgeArtifactStorage("viewer", "relay");
    await notification;
    observer.close();
    const reopened = createArtifactStore("viewer", "relay");
    const a = reopened.collection("test", definition);
    const b = reopened.collection("test", { ...definition, name: "two" });
    const retained = createArtifactStore("other", "relay");
    const values = {
      one: await a.get("task"),
      two: await b.get("task"),
      pref: await a.preferences.get("task"),
      marker: await a.imported("done"),
      other: await retained.collection("test", definition).get("task"),
    };
    reopened.close();
    retained.close();
    return values;
  });
  expect(result.one).toBeUndefined();
  expect(result.two).toBeUndefined();
  expect(result.pref).toBeUndefined();
  expect(result.marker).toBe(false);
  expect(result.other.preference).toBe(false);
});

test("upgrades saved device data and removes the obsolete membership store", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-artifacts-v1", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of [
          "records",
          "preferences",
          "entries",
          "metadata",
          "members",
        ]) {
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
          if (name === "entries" || name === "members")
            store.createIndex("record", ["scope", "collection", "id"]);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["records", "preferences"], "readwrite");
        const prefix = {
          scope: "relay:viewer",
          collection: JSON.stringify(["test", "tasks"]),
          id: "task",
        };
        tx.objectStore("records").put({
          ...prefix,
          record: {
            id: "task",
            local: { title: "saved" },
            availability: { state: "unknown" },
          },
        });
        tx.objectStore("preferences").put({
          ...prefix,
          value: { pinned: false },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    const c = window.artifactTest.open();
    const saved = await c.get("task");
    const page = await c.page({ index: "pin", value: "false" });
    const schema = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-artifacts-v1");
      request.onsuccess = () => {
        const db = request.result;
        resolve({
          version: db.version,
          members: db.objectStoreNames.contains("members"),
        });
        db.close();
      };
      request.onerror = () => reject(request.error);
    });
    return { saved, rows: page.entries.length, schema };
  });
  expect(result.saved.record.local).toEqual({ title: "saved" });
  expect(result.saved.preference).toEqual({ pinned: false });
  expect(result.rows).toBe(1);
  expect(result.schema).toEqual({ version: 2, members: false });
});

test("retries database opening with a new handle after a transient failure", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const { createArtifactStore } = await import(
      "/src/features/artifact-storage/store.ts"
    );
    const store = createArtifactStore("viewer", "relay");
    const definition = {
      name: "retry",
      type: "test.task",
      version: 1,
      project: () => [],
    };
    const original = IDBFactory.prototype.open;
    let attempts = 0;
    IDBFactory.prototype.open = function (...args) {
      if (++attempts === 1)
        throw new DOMException("Temporary open failure", "UnknownError");
      return original.apply(this, args);
    };
    try {
      const failed = store.collection("test", definition);
      const error = await failed.get("task").then(
        () => "unexpected",
        (e) => e.message,
      );
      failed.close();
      const retried = store.collection("test", definition);
      await retried.importBatch({ records: [{ id: "task", local: {} }] });
      return { error, attempts, saved: !!(await retried.get("task")) };
    } finally {
      IDBFactory.prototype.open = original;
      store.close();
    }
  });
  expect(result).toEqual({
    error: "Temporary open failure",
    attempts: 2,
    saved: true,
  });
});
