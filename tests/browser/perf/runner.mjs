import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { settle, virtuaIdle } from "../timeline.mjs";

export { expect };
export const timeline = (id) => `section[data-channel-timeline="${id}"]`;
export const sidebar = (id) => `button[data-channel-id="${id}"]`;
export const repeats = Number(process.env.PERF_REPEAT ?? 1);
export const heads = (app, id) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter?.["#h"]?.includes(id) &&
      filter.top_level &&
      filter.until === undefined,
  ).length;

// One observer per operation, owned by its JSHandle. No global recorder or
// surviving animation-frame loop. Geometry reads are included in browser costs.
function observe({ selector, ids, click, hoverMs }) {
  const allowed = new Set(ids);
  const frames = [];
  let start,
    done = false,
    firstRowsMs,
    previous,
    quietSince,
    raf,
    timer,
    resolve;
  let wheels = 0;
  let inputAt, hoverAt;
  let gestureStartMs, gestureEndMs;
  const hovered = (event) => {
    if (hoverMs && event.target.closest(click)) hoverAt ??= performance.now();
  };
  const clicked = (event) => {
    if (click && event.target.closest(click)) inputAt = performance.now();
  };
  const result = new Promise((r) => {
    resolve = r;
  });
  const wheel = (event) => {
    if (event.target.closest(selector)) {
      wheels++;
      gestureStartMs ??= performance.now() - start;
    }
  };
  document.addEventListener("wheel", wheel, { passive: true });
  document.addEventListener("click", clicked, true);
  document.addEventListener("pointerover", hovered, true);
  function stop(error) {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    document.removeEventListener("wheel", wheel);
    document.removeEventListener("click", clicked, true);
    document.removeEventListener("pointerover", hovered, true);
    resolve({
      error,
      frames,
      wheels,
      gestureStartMs,
      gestureEndMs,
      firstRowsMs,
      hoverLeadMs:
        hoverAt === undefined || inputAt === undefined
          ? undefined
          : inputAt - hoverAt,
      inputDelayMs: inputAt === undefined ? undefined : inputAt - start,
      durationMs: performance.now() - start,
    });
  }
  function sample() {
    const now = performance.now();
    const element = document.querySelector(selector);
    const bounds = element?.getBoundingClientRect();
    const rows = element
      ? [...element.querySelectorAll("[data-message-id]")].flatMap((row) => {
          if (
            !allowed.has(row.dataset.messageId) ||
            !row.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            })
          )
            return [];
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom
            ? [[row.dataset.messageId, rect.y, rect.height]]
            : [];
        })
      : [];
    const frame = {
      t: now - start,
      top: element?.scrollTop ?? null,
      height: element?.scrollHeight ?? null,
      rows,
    };
    frames.push(frame);
    // rAF is before paint: require visible rows in two successive rendering
    // updates, providing a paint opportunity, not proof of compositor pixels.
    if (
      firstRowsMs === undefined &&
      rows.length &&
      frames.at(-2)?.rows.length &&
      (!click || inputAt !== undefined)
    )
      firstRowsMs = now - (inputAt ?? start);
    const signature = JSON.stringify([frame.top, frame.height, rows]);
    if (signature !== previous || !rows.length) quietSince = now;
    previous = signature;
    if (
      done &&
      firstRowsMs !== undefined &&
      now - quietSince >= 200 &&
      frames.length >= 3
    )
      stop();
    else raf = requestAnimationFrame(sample);
  }
  return {
    waitForHover() {
      if (hoverAt === undefined)
        throw new Error("Hover did not reach the target");
      return new Promise((r) =>
        setTimeout(
          r,
          Math.ceil(Math.max(0, hoverMs - (performance.now() - hoverAt))),
        ),
      );
    },
    start() {
      start = performance.now();
      quietSince = start;
      timer = setTimeout(
        () => stop("Timeline did not settle within 10s"),
        10_000,
      );
      raf = requestAnimationFrame(sample);
    },
    done() {
      // The scrolling action resolves after Chromium's synthetic gesture does.
      // This existing browser marker includes the completion protocol dispatch.
      if (gestureStartMs !== undefined)
        gestureEndMs = performance.now() - start;
      done = true;
    },
    result: () => result,
    stop: () => stop("Measurement interrupted"),
  };
}

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
export const test = base.extend({
  perf: async ({ page, app }, use, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const read = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(
        Object.entries(counters).map(([key, name]) => {
          const value = metrics.find((m) => m.name === name)?.value;
          if (!Number.isFinite(value))
            throw new Error(`Missing browser counter ${name}`);
          return [key, value * 1000];
        }),
      );
    };
    const perf = {
      cdp,
      async setup(id) {
        await page.goto(app.origin);
        await openPage(page, "Messages");
        await page.evaluate(async () => {
          await Promise.all([...document.fonts].map((font) => font.load()));
        });
        await perf.open(id);
      },
      async open(id) {
        await page.locator(sidebar(id)).evaluate((row) => row.click());
        await expect(
          page.locator(`${timeline(id)} [data-message-id]`).first(),
        ).toBeVisible();
        await virtuaIdle(page, page.locator(timeline(id)));
      },
      async measure(id, { click, hoverMs = 0, act, work = {} }) {
        const ids = app.histories.get(`primary/${id}`).map((event) => event.id);
        const box = click ? await page.locator(click).boundingBox() : null;
        if (click && !box) throw new Error(`Missing click target: ${click}`);
        const point = box
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : null;
        let observer, recording;
        const sample = { state: app.report.state, work, metrics: {} };
        try {
          await cdp.send("Emulation.setCPUThrottlingRate", {
            rate: Number(process.env.PERF_CPU),
          });
          observer = await page.evaluateHandle(observe, {
            selector: timeline(id),
            ids,
            click,
            hoverMs,
          });
          if (hoverMs) {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...point,
            });
            await observer.evaluate((o) => o.waitForHover());
          }
          if (click) sample.work.headReadsBefore = heads(app, id);
          const before = await read();
          await observer.evaluate((o) => o.start());
          if (click) {
            // Browser input counts synchronous handlers in ScriptDuration.
            // evaluate(() => element.click()) does not. Only the hover case
            // moves the pointer first; cold preparation starts in this window.
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              ...point,
              button: "left",
              clickCount: 1,
            });
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              ...point,
              button: "left",
              clickCount: 1,
            });
          }
          if (act) await act();
          await observer.evaluate((o) => o.done());
          recording = await observer.evaluate((o) => o.result());
          const after = await read();
          for (const key of Object.keys(counters)) {
            sample.metrics[key] = after[key] - before[key];
            expect(sample.metrics[key], key).toBeGreaterThanOrEqual(0);
          }
          sample.recording = recording;
          sample.metrics.durationMs = recording.durationMs;
          if (click) {
            sample.metrics.firstRowsMs = recording.firstRowsMs;
            sample.work.headReadsDuring =
              heads(app, id) - sample.work.headReadsBefore;
          }
          expect(recording.error).toBeUndefined();
          return sample;
        } finally {
          if (observer) {
            await observer.evaluate((o) => o.stop());
            sample.recording ??= await observer.evaluate((o) => o.result());
            await observer.dispose();
          }
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          // The scenario may add work assertions afterwards. Reporter includes
          // this sample in summaries only if the whole test/fixture passed.
          app.report.measurements.push(sample);
        }
      },
      async save(sample) {
        await testInfo.attach("perf-sample", {
          body: JSON.stringify(sample),
          contentType: "application/json",
        });
      },
      settle: (id) => settle(page, page.locator(timeline(id))),
    };
    try {
      await use(perf);
    } finally {
      await cdp.detach();
    }
  },
});
