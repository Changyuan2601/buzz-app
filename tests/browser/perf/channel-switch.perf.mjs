import { test, expect, heads, repeats, sidebar, timeline } from "./runner.mjs";

// Returning to channels already opened this session: the most common move.
// Setup opens beta, then alpha; the sample measures beta, alpha, beta.
const route = ["beta", "alpha", "beta"];
const counters = ["scriptMs", "layoutMs", "styleMs", "taskMs"];

// The tall variant keeps channel-open-cold-markdown's row heights.
for (const [name, options] of [
  ["channel-switch-warm", { shortMessages: true }],
  ["channel-switch-warm-tall", {}],
])
  test.describe(name, () => {
    test.use({
      historyCounts: { alpha: 120, beta: 120 },
      markdownMessages: true,
      ...options,
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ page, app, perf }) => {
        await perf.setup("beta");
        await perf.open("alpha");
        const newest = (id) => app.histories.get(`primary/${id}`).at(-1).id;
        const switches = [];
        let from = "alpha";
        for (const id of route) {
          expect(heads(app, id), `${id} was opened before`).toBeGreaterThan(0);
          // Each switch starts from the settled previous channel.
          await perf.settle(from);
          const sample = await perf.measure(id, {
            click: sidebar(id),
            work: { mode: "warm", from },
          });
          // Receipts: served from the session without a new head read, the
          // target is current, the previous timeline is gone and the settled
          // view shows the target's newest message.
          expect(sample.work.headReadsDuring, "warm switch reads no head").toBe(
            0,
          );
          await expect(page.locator(sidebar(id))).toHaveAttribute(
            "aria-current",
            "page",
          );
          await expect(page.locator(timeline(from))).toHaveCount(0);
          const settled = sample.recording.frames
            .at(-1)
            .rows.map(([row]) => row);
          sample.work.newestVisible = settled.includes(newest(id));
          sample.work.rowsVisible = settled.length;
          expect(
            sample.work.newestVisible,
            `${id} opens at its newest row`,
          ).toBe(true);
          expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
          switches.push(sample);
          from = id;
        }
        const total = (key) =>
          switches.reduce((sum, { metrics }) => sum + metrics[key], 0);
        const metrics = Object.fromEntries(
          [...counters, "durationMs", "loafBlockingMs", "firstRowsMs"].map(
            (key) => [key, total(key)],
          ),
        );
        metrics.firstRowsMaxMs = Math.max(
          ...switches.map((s) => s.metrics.firstRowsMs),
        );
        switches.forEach((s, n) => {
          metrics[`switch${n + 1}FirstRowsMs`] = s.metrics.firstRowsMs;
        });
        await perf.save({
          state: app.report.state,
          work: {
            mode: "warm",
            route,
            headReadsDuring: switches.reduce(
              (sum, s) => sum + s.work.headReadsDuring,
              0,
            ),
            switches: switches.map((s) => s.work),
          },
          metrics,
          recording: { switches: switches.map((s) => s.recording) },
        });
      });
  });
