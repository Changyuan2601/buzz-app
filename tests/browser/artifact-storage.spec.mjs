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
  await page.reload();
  await page.waitForFunction(() => !!window.artifactTest);
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const collection = window.artifactTest.open();
    return {
      row: await collection.get("task"),
      marker: await collection.imported("done"),
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
        revision: { id: "a", parents: [], content: "{}" },
      },
      {
        id: "bad",
        channelId: "channel",
        type: "test.task",
        revision: { id: "cycle", parents: ["cycle"], content: "{}" },
      },
    ];
    const failure = await c
      .applyBatch({
        source: "all",
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
    failure: "Artifact revision ancestry cycle",
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

test("reconciles only completed snapshot scopes and fences newer live commits", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const row = (id, revision = id) => ({
      id,
      channelId: "channel",
      type: "test.task",
      revision: { id: revision, parents: [], content: "{}" },
    });
    await c.applyBatch({
      source: "one",
      records: [row("missing"), row("live"), row("seen")],
      availability: ["missing", "live", "seen"].map((id) => ({
        id,
        expectedRevision: id,
        value: { state: "available" },
      })),
    });
    await c.applyBatch({ source: "other", records: [row("outside")] });
    await c.preferences.update("missing", () => ({ pinned: false }));
    const snapshot = await c.beginSnapshot("one");
    await c.applyBatch({ source: "one", snapshot, records: [row("seen")] });
    await c.applyBatch({
      source: "one",
      records: [row("new"), row("live", "new-live")],
    });
    const before = await c.get("missing");
    await c.completeSnapshot(snapshot, { expected: null, next: "complete" });
    const stale = await c
      .completeSnapshot(snapshot, { expected: null, next: "wrong" })
      .then(
        () => "unexpected",
        (error) => error.message,
      );
    const interrupted = await c.beginSnapshot("one");
    const replacement = await c.beginSnapshot("one");
    const invalidated = await c
      .completeSnapshot(interrupted, { expected: "complete", next: "wrong" })
      .then(
        () => "unexpected",
        (error) => error.message,
      );
    return {
      before,
      rows: await Promise.all(
        ["missing", "live", "seen", "new", "outside"].map((id) => c.get(id)),
      ),
      checkpoint: await c.checkpoint(),
      stale,
      invalidated,
      replacement: !!replacement,
    };
  });
  expect(result.before.record.availability.state).toBe("available");
  expect(result.rows.map((entry) => entry.record.availability.state)).toEqual([
    "unavailable",
    "available",
    "available",
    "unknown",
    "unknown",
  ]);
  expect(result.rows[0].record.current.content).toBe("{}");
  expect(result.rows[0].preference).toEqual({ pinned: false });
  expect(result.checkpoint).toBe("complete");
  expect(result.stale).toBe("Artifact snapshot changed");
  expect(result.invalidated).toBe("Artifact snapshot changed");
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

test("fences authoritative snapshot heads, moved homes, and stale availability", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id, parents, channelId = "old-home") => ({
      id: "task",
      channelId,
      type: "test.task",
      revision: { id, parents, content: "{}" },
    });
    const availability = (expectedRevision, state) => ({
      id: "task",
      expectedRevision,
      value: { state },
    });
    await c.applyBatch({
      source: "all",
      records: [record("A", [])],
      availability: [availability("A", "available")],
    });
    const snapshot = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      snapshot,
      records: [record("C", ["missing-B"], "moved-home")],
      availability: [availability("C", "available")],
    });
    const authoritative = await c.get("task");
    const next = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      records: [record("D", ["C"], "new-home")],
      availability: [availability("D", "deleted")],
    });
    await c.applyBatch({
      source: "all",
      snapshot: next,
      records: [record("C", ["missing-B"], "moved-home")],
      availability: [availability("C", "available")],
    });
    await c.applyBatch({
      source: "all",
      records: [record("A", [])],
      availability: [availability("A", "available")],
    });
    const after = await c.get("task");
    const oldSnapshot = await c.beginSnapshot("all");
    await c.applyBatch({
      source: "all",
      snapshot: oldSnapshot,
      records: [record("A", [])],
    });
    const oldHead = await c.get("task");
    await c.applyBatch({
      source: "all",
      snapshot: oldSnapshot,
      seen: [{ id: "task", revisionId: "C" }],
    });
    await c.completeSnapshot(oldSnapshot, { expected: null, next: "seen" });
    return { authoritative, after, oldHead, final: await c.get("task") };
  });
  expect(result.authoritative.record.current.id).toBe("C");
  expect(result.authoritative.record.channelId).toBe("moved-home");
  expect(result.authoritative.record.unresolved).toBe(true);
  expect(result.authoritative.record.conflicts.map((r) => r.id)).toEqual(["A"]);
  for (const entry of [result.after, result.oldHead, result.final]) {
    expect(entry.record.current.id).toBe("D");
    expect(entry.record.channelId).toBe("new-home");
    expect(entry.record.availability.state).toBe("deleted");
  }
});

test("aborts snapshot completion before and during the local transaction", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    let controller;
    let abortOnProjection = false;
    const c = window.artifactTest.open("viewer", "relay", "test", {
      project() {
        if (abortOnProjection)
          controller.abort(new Error("live interval lost"));
        return [];
      },
    });
    await c.applyBatch({
      source: "all",
      records: [
        {
          id: "task",
          channelId: "channel",
          type: "test.task",
          revision: { id: "A", parents: [], content: "{}" },
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
    return {
      before,
      during,
      row: await c.get("task"),
      checkpoint: await c.checkpoint(),
    };
  });
  expect(result.before).toBe("owner closed");
  expect(result.during).toBe("live interval lost");
  expect(result.row.record.availability.state).toBe("available");
  expect(result.checkpoint).toBeNull();
});

test("rebuilds projection versions atomically and preserves explicit null preferences", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    await c.importBatch({
      records: [{ id: "task", local: {} }],
      preferences: [{ id: "task", value: true }],
    });
    const newer = window.artifactTest.open("viewer", "relay", "test", {
      version: 2,
      project: ({ preference }) => [
        { index: "value", value: JSON.stringify(preference), order: "" },
      ],
    });
    await newer.preferences.update("task", () => null);
    const page = await newer.page({ index: "value", value: "null" });
    const old = await c.get("task").then(
      () => "unexpected",
      (e) => e.message,
    );
    const older = window.artifactTest.open();
    const downgrade = await older.get("task").then(
      () => "unexpected",
      (e) => e.message,
    );
    return { page, old, downgrade };
  });
  expect(result.page.entries[0].preference).toBeNull();
  expect(result.old).toBe("Artifact collection version changed");
  expect(result.downgrade).toBe("Artifact collection requires a newer plugin");
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

test("keeps a pending revision's home and reconciles overlapping sources separately", async ({
  page,
  storageUrl,
}) => {
  await open(page, storageUrl);
  const result = await page.evaluate(async () => {
    const c = window.artifactTest.open();
    const record = (id, parents, channelId) => ({
      id: "task",
      channelId,
      type: "test.task",
      revision: { id, parents, content: "{}" },
    });
    await c.applyBatch({
      source: "old-home",
      records: [record("A", [], "old-home")],
      availability: [
        { id: "task", expectedRevision: "A", value: { state: "available" } },
      ],
    });
    await c.applyBatch({
      source: "new-home",
      records: [record("C", ["B"], "new-home")],
    });
    await c.applyBatch({
      source: "new-home",
      records: [record("B", ["A"], "old-home")],
    });
    const moved = await c.get("task");
    const old = await c.beginSnapshot("old-home");
    await c.completeSnapshot(old, { expected: null, next: "old-complete" });
    const retained = await c.get("task");
    const next = await c.beginSnapshot("new-home");
    await c.completeSnapshot(next, {
      expected: "old-complete",
      next: "all-complete",
    });
    return { moved, retained, absent: await c.get("task") };
  });
  expect(result.moved.record.current.id).toBe("C");
  expect(result.moved.record.channelId).toBe("new-home");
  expect(result.retained.record.availability.state).toBe("available");
  expect(result.absent.record.availability.state).toBe("unavailable");
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
