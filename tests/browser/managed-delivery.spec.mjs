import { fileURLToPath } from "node:url";
import { test as base, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

const test = base.extend({
  deliveryUrl: [
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
          `${server.resolvedUrls.local[0]}tests/fixtures/managed-delivery.html`,
        );
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});
async function open(page, url, scope) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.deliveryTest);
  await page.evaluate((scope) => window.deliveryTest.open(scope), scope);
}

// These checks use real IndexedDB, BroadcastChannel and Web Locks across windows.
test("transfers ownership on window close and never republishes accepted work", async ({
  page,
  context,
  deliveryUrl,
}) => {
  const scope = "owner-transfer";
  await open(page, deliveryUrl, scope);
  const second = await context.newPage();
  await open(second, deliveryUrl, scope);
  await page.evaluate((scope) => window.deliveryTest.own(scope), scope);
  const operation = await second.evaluate(() => window.deliveryTest.submit());
  await expect
    .poll(() => page.evaluate(() => window.deliveryTest.publications.length))
    .toBe(1);
  await expect
    .poll(() =>
      second.evaluate((id) => window.deliveryTest.get(id), operation.eventId),
    )
    .toMatchObject({ relayAccepted: true, agentReceived: false });
  const transfer = second.evaluate(
    (scope) => window.deliveryTest.own(scope),
    scope,
  );
  await page.close();
  await transfer;
  await second.evaluate(
    (id) => window.deliveryTest.retry(id),
    operation.eventId,
  );
  await second.evaluate(
    (id) => window.deliveryTest.receive(id),
    operation.eventId,
  );
  expect(
    await second.evaluate(
      (id) => window.deliveryTest.get(id),
      operation.eventId,
    ),
  ).toMatchObject({ phase: "received" });
  expect(await second.evaluate(() => window.deliveryTest.publications)).toEqual(
    [],
  );
  await second.reload();
  await second.waitForFunction(() => !!window.deliveryTest);
  await second.evaluate((scope) => window.deliveryTest.open(scope), scope);
  expect(
    await second.evaluate(
      (id) => window.deliveryTest.get(id),
      operation.eventId,
    ),
  ).toMatchObject({ relayAccepted: true, agentReceived: true });
});

test("keeps accepted and received facts through a stale window save", async ({
  page,
  context,
  deliveryUrl,
}) => {
  const scope = "stale-save";
  await open(page, deliveryUrl, scope);
  const second = await context.newPage();
  await open(second, deliveryUrl, scope);
  const operation = await page.evaluate(() => window.deliveryTest.submit());
  await second.evaluate(async (scope) => {
    window.staleStorage = window.deliveryTest.storage(scope);
    window.staleRecords = await window.staleStorage.load();
  }, scope);
  await page.evaluate((scope) => window.deliveryTest.own(scope), scope);
  await expect
    .poll(() =>
      page.evaluate((id) => window.deliveryTest.get(id), operation.eventId),
    )
    .toMatchObject({ relayAccepted: true });
  await page.evaluate(
    (id) => window.deliveryTest.receive(id),
    operation.eventId,
  );
  await second.evaluate(async () => {
    await window.staleStorage.save(
      window.staleRecords.map((item) => ({
        ...item,
        error: "stale",
        managed: { ...item.managed, attempts: 1 },
      })),
    );
  });
  expect(
    await page.evaluate((id) => window.deliveryTest.get(id), operation.eventId),
  ).toMatchObject({
    relayAccepted: true,
    agentReceived: true,
    phase: "received",
  });
  await page.evaluate(() => window.deliveryTest.release());
});

// This uses the production sync owner with real Web Locks. The relay reader is deterministic.
test("syncs a follower-only collection and transfers a shared collection on window close", async ({
  page,
  context,
  deliveryUrl,
}) => {
  const scope = "collection-owner";
  await open(page, deliveryUrl, scope);
  const second = await context.newPage();
  await open(second, deliveryUrl, scope);
  await page.evaluate(
    (scope) => window.deliveryTest.openCollection(scope, "main"),
    scope,
  );
  await expect
    .poll(() => page.evaluate(() => window.deliveryTest.captures))
    .toEqual(["main"]);
  await second.evaluate(
    (scope) => window.deliveryTest.openCollection(scope, "archive"),
    scope,
  );
  await expect
    .poll(() => second.evaluate(() => window.deliveryTest.captures))
    .toEqual(["archive"]);
  await second.evaluate(
    (scope) => window.deliveryTest.openCollection(scope, "main"),
    scope,
  );
  await page.close();
  await expect
    .poll(() => second.evaluate(() => window.deliveryTest.captures))
    .toEqual(["archive", "main"]);
  expect(
    (await second.evaluate(() => window.deliveryTest.readCollection()))
      .preference,
  ).toEqual({ pinned: false });
});
