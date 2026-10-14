// Upward flings from the newest row (Input.synthesizeScrollGesture):
// - history: into unloaded history (older pages after 300ms), into loaded but
//   never-measured rows, and slow reading steps while prefetched pages land;
// - restored: a fully measured channel reopened from its geometry snapshot,
//   which keeps Virtua's buffer off, flung at three speeds;
// - stale sizes: a measured channel flung once (control), then again after the
//   window narrows, over rows still measured at the old width.
import { corpusOptions, test, timeline } from "./harness.mjs";
import { fling, frameAt, frames, stats } from "./metrics.mjs";

const H = "5c1b6c61-6464-4472-8000-0000000000b1";
const B = "5c1b6c61-6464-4472-8000-000000000001";
const C = "5c1b6c61-6464-4472-8000-000000000002";
const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);

/** One measured gesture, or `steps` of them, each followed by a reader's pause:
 * until the page is quiet for 400ms, or 8s at most (a jumping page may never
 * be quiet, and that is what the pause measures). */
async function flung(perf, id, label, { dy, speed, steps = 1 }) {
  const at = await perf.park(timeline(id));
  const run = await perf.record(label, async () => {
    for (let step = 0; step < steps; step++) {
      await perf.gesture({ dy, speed, at });
      if (steps > 1) await perf.quiet(400);
    }
  });
  const result = fling(run.session);
  perf.require(`${label}: wheel input`, result.wheels > 0);
  return { ...result, ...run };
}
const guards = (f) => ({
  scriptMs: f.scriptMs,
  settleMs: f.settleMs,
  droppedFrames: f.input?.droppedFrames,
});

const history = { [H]: { name: "History deep", count: 360, seed: 21 } };
test.describe("history", () => {
  test.use(corpusOptions(history));
  test("fling into unloaded history", async ({ perf }) => {
    await perf.setup(H);
    const f = await flung(perf, H, "unloaded", { dy: 30000, speed: 8000 });
    const olderPages = f.session.fetches.filter(
      ([, end, older]) => older && end,
    );
    perf.require("older pages loaded", olderPages.length > 0);
    perf.require("history remained loadable", f.loadable);
    await perf.result("scroll", "unloaded", {
      targets: {
        screenBlankMs: f.input?.screenBlankMs,
        deadInputMs: f.input?.deadInputMs,
      },
      defects: { "afterStop.shiftPx": f.afterStop?.shiftPx },
      guards: guards(f),
      // Hidden (unmeasured) time is a part of screenBlankMs.
      work: { hiddenMs: f.input?.hiddenMs, olderPages: olderPages.length },
    });
  });
  test("fling into unmeasured rows", async ({ perf }) => {
    await perf.setup(H);
    perf.require("history preloaded", (await perf.loadAllHistory(H)) > 0);
    const f = await flung(perf, H, "unmeasured", { dy: 12000, speed: 4000 });
    perf.require(
      "unmeasured rows mounted",
      f.series.some((r) => r.rows?.some((x) => x.hidden)),
    );
    await perf.result("scroll", "unmeasured", {
      defects: { hiddenMs: f.input?.hiddenMs, shiftPx: f.input?.shiftPx },
      guards: guards(f),
    });
  });
});

test.describe("history, slow older pages", () => {
  // Older pages are prefetched mid-gesture; a read slower than one reading
  // step (1.3s) lands while the reader is still.
  test.use(corpusOptions(history, { olderReadDelayMs: 2000 }));
  test("reading steps while older pages land", async ({ perf }) => {
    await perf.setup(H);
    const f = await flung(perf, H, "reading", {
      dy: 1200,
      speed: 900,
      steps: 8,
    });
    const { wheels, fetches } = f.session;
    const pauses = [];
    for (let i = 1; i < wheels.length; i++)
      if (wheels[i] - wheels[i - 1] > 300)
        pauses.push([wheels[i - 1] + 150, wheels[i]]);
    const idle = pauses.map(([from, to]) =>
      stats(f.series, frameAt(f.series, from), frameAt(f.series, to)),
    );
    perf.require("reading pauses", idle.length >= 4 && idle.every(Boolean));
    perf.require(
      "pages landed while reading",
      pauses.some(([from, to]) =>
        fetches.some(([, end, older]) => older && end >= from && end < to),
      ),
    );
    await perf.result("scroll", "reading", {
      defects: {
        shiftPx: f.input?.shiftPx,
        "idle.shiftPx": idle.every(Boolean) ? sum(idle, "shiftPx") : null,
      },
      guards: guards(f),
    });
  });
});

test.describe("measured channel", () => {
  test.use(
    corpusOptions(
      {
        [B]: { name: "Bravo ladder", count: 200, seed: 11 },
        [C]: { name: "Charlie side", count: 40, seed: 12 },
      },
      { olderReadDelayMs: 0, reference: "#Bravo ladder" },
    ),
  );
  /** Load and measure all of B's history, unthrottled. */
  const prepare = async (perf) => {
    await perf.setup(B);
    await perf.loadAllHistory(B);
    await perf.traverse(B);
  };
  /** An 8000px fling from the settled bottom; it must travel at least half. */
  const rung = async (perf, label, speed) => {
    await perf.toBottom();
    const f = await flung(perf, B, label, { dy: 8000, speed });
    perf.require(
      `${label}: travelled`,
      f.travelledPx >= 4000,
      `${f.travelledPx}px`,
    );
    return f;
  };

  test("restored geometry ladder", async ({ perf }, testInfo) => {
    await prepare(perf);
    await perf.openChannel(C);
    const reopen = await perf.click("reopen", `button[data-channel-id="${B}"]`);
    const first = frames(reopen.session, "timeline", B).find(
      (r) => !r.absent && r.rows.length,
    );
    perf.require(
      "geometry restored on reopen",
      first && !first.rows.some((r) => r.hidden),
    );
    // Alternate the order across iterations, so warm-up does not favour a speed.
    const speeds = [2000, 6000, 11000];
    if (
      (testInfo.repeatEachIndex + Number(process.env.PERF_ITERATION ?? 0)) %
      2
    )
      speeds.reverse();
    const rungs = [];
    for (const speed of speeds) {
      const f = await rung(perf, `rung-${speed}`, speed);
      rungs.push({ ...f.input, scriptMs: f.scriptMs, settleMs: f.settleMs });
    }
    await perf.result("scroll", "restored", {
      targets: { screenBlankMs: sum(rungs, "screenBlankMs") },
      guards: {
        scriptMs: sum(rungs, "scriptMs"),
        settleMs: sum(rungs, "settleMs"),
        droppedFrames: sum(rungs, "droppedFrames"),
      },
    });
  });

  test("stale sizes: control, then narrowed", async ({ page, perf }) => {
    await prepare(perf);
    const width = () =>
      page.locator(timeline(B)).evaluate((element) => element.clientWidth);
    const control = await rung(perf, "control", 3000);
    await perf.toBottom();
    const before = await width();
    // Above the 62.5rem breakpoint, so only the timeline column narrows.
    await page.setViewportSize({ width: 1100, height: 950 });
    const narrowed = await rung(perf, "narrowed", 3000);
    perf.require("timeline narrowed", (await width()) < before);
    await perf.result("scroll", "stale", {
      defects: {
        extraCorrections:
          narrowed.input?.corrections - control.input?.corrections,
        "narrowed.shiftPx": narrowed.input?.shiftPx,
        "narrowed.overlapPx": narrowed.input?.overlapPx,
        // Rows that mount once a warm fling has stopped.
        "control.afterStopRows": control.stopped?.rowsAdded,
      },
      guards: {
        "control.scriptMs": control.scriptMs,
        "control.settleMs": control.settleMs,
        "narrowed.scriptMs": narrowed.scriptMs,
        "narrowed.settleMs": narrowed.settleMs,
      },
    });
  });
});
