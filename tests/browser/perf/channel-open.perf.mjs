// Opening a channel from the sidebar: time to the first painted rows (cold:
// never opened or hovered; prepared: the pointer rested on its row, which
// reads its head).
import { corpusOptions, expect, test, timeline } from "./harness.mjs";
import { frames, opened } from "./metrics.mjs";

const HOME = "5c1b6c61-6464-4472-8000-0000000000c0";
const X = "5c1b6c61-6464-4472-8000-0000000000c1";
const Y = "5c1b6c61-6464-4472-8000-0000000000c2";
test.use(
  corpusOptions(
    {
      [X]: { name: "Xray open", count: 120, seed: 31 },
      [Y]: { name: "Yankee open", count: 120, seed: 32 },
      [HOME]: { name: "Home base", count: 60, seed: 30 },
    },
    { queryDelayMs: 80 },
  ),
);

/** Head reads of channel `id` so far (top-level, no `until`). */
const heads = (app, id) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter?.["#h"]?.includes(id) &&
      filter.top_level &&
      filter.until === undefined,
  ).length;

async function open(perf, app, id, label) {
  let before;
  const run = await perf.record(label, () => {
    // After the idle barrier: reads before this point are not the open's.
    before = heads(app, id);
    return perf.act(
      (row) => document.querySelector(row).click(),
      `button[data-channel-id="${id}"]`,
    );
  });
  const series = frames(run.session, "timeline", id);
  const result = opened(series, run.from);
  perf.require(`${label}: rows painted`, result.firstRowsMs != null);
  return { ...run, ...result, before, reads: heads(app, id) - before };
}

test("channel open: cold and prepared", async ({ app, perf }) => {
  await perf.setup(HOME);
  await perf.park(timeline(HOME));
  const cold = await open(perf, app, X, "cold");
  perf.require(
    "cold: head read by the open",
    cold.before === 0 && cold.reads >= 1,
    `${cold.before} before, ${cold.reads} during`,
  );

  await perf.openChannel(HOME);
  await perf.hover(Y);
  // Prepared: the hover has read Y's head (the idle barrier lets it finish).
  await expect.poll(() => heads(app, Y)).toBeGreaterThan(0);
  const prepared = await open(perf, app, Y, "prepared");
  const guards = (name, c) => ({
    [`${name}.scriptMs`]: c.scriptMs,
    [`${name}.settleMs`]: c.settleMs,
  });
  await perf.result("channel-open", "sequence", {
    targets: {
      "cold.firstRowsMs": cold.firstRowsMs,
      "prepared.firstRowsMs": prepared.firstRowsMs,
    },
    guards: {
      "cold.completeMs": cold.completeMs,
      "prepared.completeMs": prepared.completeMs,
      ...guards("cold", cold),
      ...guards("prepared", prepared),
    },
    work: {
      "cold.reads": cold.reads,
      "prepared.headReadsBefore": prepared.before,
      "prepared.reads": prepared.reads,
    },
  });
});
