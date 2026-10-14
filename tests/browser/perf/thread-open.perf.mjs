// Opening a thread from its summary: time until the newest reply is at the
// bottom of the panel, and what the main timeline does as the dock narrows it
// (rows rewrap at stale positions and overlap for a frame).
import { corpusOptions, test, timeline } from "./harness.mjs";
import { frames, stats } from "./metrics.mjs";

const T = "5c1b6c61-6464-4472-8000-0000000000e1";
test.use(
  corpusOptions(
    {
      [T]: {
        name: "Thread tango",
        count: 120,
        seed: 51,
        longThread: { replies: 60, fromNewest: 1 },
      },
    },
    { queryDelayMs: 80 },
  ),
);

/** The long thread, or the summary nearest the bottom of the view. */
const roots = {
  long: (_page, app) => app.corpus.longThreads[T].root,
  short: (page, app) =>
    page.evaluate(
      ({ selector, long }) => {
        const view = document.querySelector(selector).getBoundingClientRect();
        return [...document.querySelectorAll(`${selector} [data-message-id]`)]
          .filter(
            (row) =>
              row.dataset.messageId !== long &&
              row.querySelector("button[data-thread-summary]") &&
              row.getBoundingClientRect().top >= view.top &&
              row.getBoundingClientRect().bottom <= view.bottom,
          )
          .at(-1)?.dataset.messageId;
      },
      { selector: timeline(T), long: app.corpus.longThreads[T].root },
    ),
};

for (const [variant, pick] of Object.entries(roots))
  test(`thread open: ${variant} thread`, async ({ page, app, perf }) => {
    await perf.setup(T);
    const root = await pick(page, app);
    perf.require("thread root found", root);
    const replies = app.corpus.replies.get(root) ?? [];
    await perf.park(timeline(T));
    const run = await perf.click(
      "open-thread",
      `${timeline(T)} [data-message-id="${root}"] button[data-thread-summary]`,
    );
    const latest = frames(run.session, "thread").find(
      (r) =>
        r.at > run.from &&
        !r.absent &&
        !r.hp &&
        r.bottomGap < 2 &&
        r.rows.some((x) => x.id === replies.at(-1)?.id && !x.hidden),
    );
    perf.require("newest reply reached", latest);
    const main = frames(run.session, "timeline", T);
    const dock = stats(
      main,
      main.find((r) => !r.absent && r.at > run.from)?.t ?? Infinity,
      run.session.stoppedAt,
    );
    const latestReplyMs = latest?.at - run.from;
    await perf.result("thread-open", variant, {
      targets: variant === "long" ? { latestReplyMs } : {},
      defects: {
        "main.overlapPx": dock?.overlapPx,
        "main.screenBlankMs": dock?.screenBlankMs,
      },
      guards: { scriptMs: run.scriptMs, settleMs: run.settleMs },
      work: {
        ...(variant === "long" ? {} : { latestReplyMs }),
        // The dock rewraps rows under the bottom pin: expected motion.
        "main.shiftPx": dock?.shiftPx,
        replies: replies.length,
      },
    });
  });
