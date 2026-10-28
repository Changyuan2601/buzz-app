import { test, expect, heads, repeats, sidebar } from "./runner.mjs";

// A relaunch restores the open conversation from localStorage, and its heads
// and community discovery from IndexedDB, before the live session answers.
const saved = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const locations = Object.entries(localStorage).flatMap(
          ([key, value]) =>
            key.endsWith(',"navigation-scope"]') && JSON.parse(value).location
              ? [JSON.parse(JSON.parse(value).location)]
              : [],
        );
        const request = indexedDB.open("buzz-channel-heads-v1", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["heads", "startup"]);
          const heads = tx.objectStore("heads").getAll();
          const startup = tx.objectStore("startup").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              channels: locations.map((location) => location.channelId),
              heads: heads.result.map((head) => head.channelId),
              discovery: startup.result.some((record) => record.data.discovery),
            });
          };
        };
      }),
  );

// Relaunch navigates to the bare app URL, as the desktop shell does, so the
// conversation comes from storage rather than a URL. Warm reuses the browser
// context (identity, localStorage, IndexedDB, HTTP cache) of a previous session
// that left `target` open; cold is the first navigation of a fresh context.
for (const [name, storageState, target, label, historyCounts] of [
  ["app-startup-warm", "warm", "beta", "Beta", { alpha: 1, beta: 120 }],
  ["app-startup-cold", "cold", "alpha", "Alpha", { alpha: 120, beta: 1 }],
])
  test.describe(name, () => {
    test.use({ historyCounts, tallMessages: true });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ app, page, perf }) => {
        const work = { storage: storageState, target };
        if (storageState === "warm") {
          await perf.setup("alpha");
          await perf.open(target);
          // Persistence is asynchronous: relaunch only once the previous
          // session has saved what the next one restores.
          await expect
            .poll(async () => {
              const { channels, heads, discovery } = await saved(page);
              return (
                channels.includes(target) && discovery && heads.includes(target)
              );
            })
            .toBe(true);
          work.savedHeads = (await saved(page)).heads.length;
        } else
          expect(
            app.report.queries,
            "no earlier session in this browser context",
          ).toEqual([]);
        const readsBefore = heads(app, target);
        const sample = await perf.measure(target, {
          navigate: () => page.goto(app.origin, { waitUntil: "commit" }),
          // Settled startup includes the live session: the composer stays
          // disabled until it connects.
          act: () =>
            expect(
              page.getByRole("textbox", {
                name: `Message #${label}`,
                exact: true,
              }),
            ).toBeEditable(),
          work,
        });
        Object.assign(sample.work, {
          navigation: await page.evaluate(
            () => performance.getEntriesByType("navigation")[0].type,
          ),
          selected: await page
            .locator(sidebar(target))
            .getAttribute("aria-current"),
          headReadsDuring: heads(app, target) - readsBefore,
          rowsAtSettle: sample.recording.frames.at(-1).rows.length,
        });
        await perf.save(sample);
        expect(sample.work.navigation).toBe("navigate");
        expect(sample.work.selected, `${target} is the open channel`).toBe(
          "page",
        );
        expect(sample.work.rowsAtSettle).toBeGreaterThan(0);
        expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
        if (storageState === "cold")
          expect(sample.work.headReadsDuring).toBeGreaterThan(0);
      });
  });
