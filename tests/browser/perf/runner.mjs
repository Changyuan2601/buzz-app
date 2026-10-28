import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { settle, virtuaIdle } from "../timeline.mjs";
import { loafBlocking } from "./blocking.mjs";
import { channelWork } from "./channel-work.mjs";

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
function observe({
  selector,
  ids,
  click,
  hoverMs,
  timeoutMs,
  chromium,
  channel,
  latestId,
}) {
  const lifetime = channel ? window.__perfChannelWork : undefined;
  // Chromium hover remains before recording; its allowed preparation starts here.
  let trigger =
    lifetime && chromium && hoverMs ? ++lifetime.sequence : undefined;
  const allowed = new Set(ids);
  const frames = [];
  const inputs = [];
  let clickFrame;
  const inputTypes = [
    "pointerover",
    "pointerdown",
    "pointerup",
    "click",
    "focus",
  ];
  const input = (event) => {
    if (start === undefined || end !== undefined) return;
    const button = event.target.closest("button");
    if (event.type === "click" && click && event.target.closest(click))
      clickFrame = frames.length;
    inputs.push({
      type: event.type,
      frameCount: frames.length,
      t: performance.now() - start,
      eventMs: event.timeStamp - start,
      trusted: event.isTrusted,
      target: click ? !!event.target.closest(click) : undefined,
      channel: button?.dataset.channelId,
      label: button?.getAttribute("aria-label") ?? button?.textContent,
    });
  };
  if (!chromium)
    for (const type of inputTypes) document.addEventListener(type, input, true);
  const longAnimationFrames = [];
  let start,
    end,
    done = false,
    firstRowsMs,
    previous,
    quietSince,
    raf,
    timer,
    resolve;
  let loafObserver, drainRaf, drainTimer;
  const collect = (entries) => {
    for (const entry of entries)
      longAnimationFrames.push({
        startMs: entry.startTime - start,
        durationMs: entry.duration,
        blockingDurationMs: entry.blockingDuration,
      });
  };
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
    if (end !== undefined) return;
    end = performance.now();
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    document.removeEventListener("wheel", wheel);
    document.removeEventListener("click", clicked, true);
    document.removeEventListener("pointerover", hovered, true);
    if (!chromium)
      for (const type of inputTypes)
        document.removeEventListener(type, input, true);
    resolve({
      error,
      ...(lifetime
        ? {
            channelWork: {
              trigger,
              end: ++lifetime.sequence,
              history: lifetime.history
                .filter((e) => e.channel === channel)
                .map((e) => ({ ...e })),
              latest: (() => {
                const row = document.querySelector(
                  `${selector} [data-message-id="${latestId}"]`,
                );
                const body = row?.querySelector("[data-message-action-anchor]");
                const a = row?.getBoundingClientRect(),
                  b = document.querySelector(selector)?.getBoundingClientRect();
                return {
                  id: row?.dataset.messageId,
                  text: body?.innerText,
                  bodyVisible: (() => {
                    const r = body?.getBoundingClientRect();
                    return !!(
                      body?.checkVisibility({
                        opacityProperty: true,
                        visibilityProperty: true,
                      }) &&
                      Math.min(r.right, b.right, innerWidth) -
                        Math.max(r.left, b.left, 0) >
                        0 &&
                      Math.min(r.bottom, b.bottom, innerHeight) -
                        Math.max(r.top, b.top, 0) >
                        0
                    );
                  })(),
                  selected: document
                    .querySelector(`button[data-channel-id="${channel}"]`)
                    ?.getAttribute("aria-current"),
                  composer: [
                    ...document.querySelectorAll(
                      "[contenteditable=true][role=textbox]",
                    ),
                  ]
                    .filter((e) => e.checkVisibility())
                    .map((e) => e.getAttribute("aria-label")),
                  visible: !!(
                    row?.checkVisibility({
                      opacityProperty: true,
                      visibilityProperty: true,
                    }) &&
                    a.bottom > b.top &&
                    a.top < b.bottom &&
                    a.right > b.left &&
                    a.left < b.right
                  ),
                  semantics: body
                    ? {
                        blockquote: body.querySelectorAll("blockquote").length,
                        em: body.querySelectorAll("em").length,
                        strong: body.querySelectorAll("strong").length,
                        delete: body.querySelectorAll("del").length,
                      }
                    : {},
                };
              })(),
              stopSnapshotMs: performance.now() - end,
            },
          }
        : {}),
      ...(!chromium
        ? {
            inputs,
            supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
          }
        : {}),
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
      durationMs: end - start,
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
      (!click ||
        (inputAt !== undefined &&
          (chromium || frames.length >= clickFrame + 2)))
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
      if (
        chromium &&
        !PerformanceObserver.supportedEntryTypes.includes(
          "long-animation-frame",
        )
      )
        throw new Error(
          "Chromium does not support long-animation-frame entries",
        );
      start = performance.now();
      if (lifetime) trigger ??= ++lifetime.sequence;
      if (chromium) {
        loafObserver = new PerformanceObserver((list) =>
          collect(list.getEntries()),
        );
        loafObserver.observe({ type: "long-animation-frame", buffered: false });
      }
      quietSince = start;
      timer = setTimeout(
        () => stop(`Timeline did not settle within ${timeoutMs}ms`),
        timeoutMs,
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
    async longFrames() {
      if (!loafObserver) return undefined;
      // stop() runs inside rAF, before Chromium finalizes that frame's entry.
      // Allow two rendering opportunities plus a task for presentation-delayed
      // delivery, outside the pinned duration and CDP counters. This is bounded,
      // not an acknowledgement of compositor presentation (see performance.md).
      await new Promise((r) => {
        drainRaf = requestAnimationFrame(() => {
          drainRaf = requestAnimationFrame(() => {
            drainTimer = setTimeout(r, 0);
          });
        });
      });
      collect(loafObserver.takeRecords());
      loafObserver.disconnect();
      return longAnimationFrames.filter(
        (entry) =>
          entry.startMs < end - start && entry.startMs + entry.durationMs > 0,
      );
    },
    stop() {
      stop("Measurement interrupted");
      cancelAnimationFrame(drainRaf);
      clearTimeout(drainTimer);
      loafObserver?.disconnect();
    },
  };
}

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
export const test = base.extend({
  channelWork: [false, { option: true }],
  perf: async (
    { page, app, browserName, channelWork: enabled },
    use,
    testInfo,
  ) => {
    const workOracle = enabled ? await channelWork(page, app) : undefined;
    const cdp =
      browserName === "chromium"
        ? await page.context().newCDPSession(page)
        : undefined;
    if (!cdp && Number(process.env.PERF_CPU ?? 1) !== 1)
      throw new Error(
        "WebKit measurements require CPU1; no slowdown control exists",
      );
    if (cdp) await cdp.send("Performance.enable");
    const read = async () => {
      if (!cdp) return {};
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
      // Wheel input uses the timeline gutter, avoiding message hover. Pointer
      // modality ends setup with a real press there, which focuses the list as
      // clicking into a conversation does. Keyboard modality keeps the palette's
      // arrow-key state, with focus outside the list.
      async gutter(id, modality) {
        const scroller = page.locator(timeline(id));
        const point = await scroller.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const list = element.querySelector("ol").getBoundingClientRect();
          return {
            x: Math.round((box.left + list.left) / 2),
            y: Math.round(box.top + box.height / 2),
          };
        });
        for (const type of modality === "pointer"
          ? ["mouseMoved", "mousePressed", "mouseReleased"]
          : ["mouseMoved"])
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: 1,
          });
        expect(
          await scroller.evaluate(
            (element, { x, y }) => ({
              inside: element.contains(document.elementFromPoint(x, y)),
              keyboard: document.documentElement.hasAttribute(
                "data-keyboard-navigation",
              ),
              listFocused: element.contains(document.activeElement),
            }),
            point,
          ),
          `pointer inside the timeline, ${modality} modality`,
        ).toEqual({
          inside: true,
          keyboard: modality === "keyboard",
          listFocused: modality === "pointer",
        });
        return point;
      },
      async measure(
        id,
        { click, hoverMs = 0, act, work = {}, timeoutMs = 10_000 },
      ) {
        const ids = app.histories.get(`primary/${id}`).map((event) => event.id);
        const box = click ? await page.locator(click).boundingBox() : null;
        if (click && !box) throw new Error(`Missing click target: ${click}`);
        const point = box
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : null;
        let observer, recording;
        const sample = {
          state: app.report.state,
          work,
          metrics: {},
          apparatus: {
            version: "main-webkit-stage-a-work-oracle-v2",
            browser: browserName,
            browserVersion: page.context().browser().version(),
            inputPolicy: click
              ? cdp
                ? "chromium-cdp-channel-original"
                : "playwright-native-channel-v1"
              : "scenario-owned-action-unchanged",
            unavailable: cdp
              ? {}
              : {
                  scriptMs: "No WebKit Performance.getMetrics counter",
                  layoutMs: "No WebKit Performance.getMetrics counter",
                  styleMs: "No WebKit Performance.getMetrics counter",
                  taskMs: "No WebKit Performance.getMetrics counter",
                  loafBlockingMs:
                    "No supported WebKit long-animation-frame instrumentation",
                  cpuThrottle: "WebKit has no CPU slowdown control; CPU1 only",
                },
          },
        };
        try {
          if (cdp)
            await cdp.send("Emulation.setCPUThrottlingRate", {
              rate: Number(process.env.PERF_CPU ?? 1),
            });
          observer = await page.evaluateHandle(observe, {
            selector: timeline(id),
            ids,
            click,
            hoverMs,
            timeoutMs,
            chromium: !!cdp,
            channel: click && enabled ? id : undefined,
            latestId: workOracle?.latest(id),
          });
          if (hoverMs && cdp) {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...point,
            });
            await observer.evaluate((o) => o.waitForHover());
          }
          if (click) {
            sample.work.headReadsBefore = heads(app, id);
            if (!cdp) {
              sample.work.targetBefore = await page
                .locator(click)
                .evaluate((element) => ({
                  hovered: element.matches(":hover"),
                  focused: element.contains(document.activeElement),
                }));
              expect(sample.work.targetBefore).toEqual({
                hovered: false,
                focused: false,
              });
              expect(sample.work.headReadsBefore).toBe(0);
            }
          }
          const before = await read();
          await observer.evaluate((o) => o.start());
          if (click && !cdp) {
            // Public mouse.click moves first: keep preparation and hover inside
            // total duration. firstRows remains relative to the actual click.
            if (hoverMs) {
              await page.mouse.move(point.x, point.y);
              await observer.evaluate((o) => o.waitForHover());
            }
            await page.mouse.click(point.x, point.y);
          } else if (click) {
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
          if (cdp)
            recording.longAnimationFrames = await observer.evaluate((o) =>
              o.longFrames(),
            );
          for (const key of Object.keys(before)) {
            sample.metrics[key] = after[key] - before[key];
            expect(sample.metrics[key], key).toBeGreaterThanOrEqual(0);
          }
          sample.recording = recording;
          sample.metrics.durationMs = recording.durationMs;
          if (cdp) sample.metrics.loafBlockingMs = loafBlocking(recording);
          if (click) {
            sample.metrics.firstRowsMs = recording.firstRowsMs;
            sample.work.headReadsDuring =
              heads(app, id) - sample.work.headReadsBefore;
          }
          if (click && !cdp) {
            const presses = recording.inputs.filter(({ type }) =>
              ["pointerdown", "pointerup", "click"].includes(type),
            );
            expect(presses.map(({ type }) => type)).toEqual([
              "pointerdown",
              "pointerup",
              "click",
            ]);
            expect(presses.every(({ target }) => target)).toBe(true);
            const targetInputs = recording.inputs.filter(
              ({ target }) => target,
            );
            expect(targetInputs.every(({ trusted }) => trusted)).toBe(true);
            expect(
              targetInputs.some(({ type }) => type === "pointerover"),
            ).toBe(true);
          }
          expect(recording.error).toBeUndefined();
          if (click && workOracle) {
            sample.work.channel = workOracle.receipt(id, recording.channelWork);
            workOracle.check(sample.work.channel);
          }
          return sample;
        } finally {
          if (observer) {
            await observer.evaluate((o) => o.stop());
            sample.recording ??= await observer.evaluate((o) => o.result());
            await observer.dispose();
          }
          if (cdp)
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          if (click && workOracle && !sample.work.channel)
            sample.work.channel = workOracle.receipt(
              id,
              sample.recording?.channelWork,
            );
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
      if (cdp) await cdp.detach();
    }
  },
});
