// Playwright extension for the perf suite (docs/performance-harness.md). A
// measured window makes no Playwright waits: actions run in the page
// (perf.act) or as one CDP gesture, and the page resolves the settle barrier.
// An iteration fails closed, after its evidence is written.
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { end, settle } from "../timeline.mjs";
import { buildIdentity, harnessHash } from "./compare.mjs";
import { installRecorder } from "./recorder.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const harness = harnessHash(root);
const build = buildIdentity(root);

export const timeline = (id) => `section[data-channel-timeline="${id}"]`;
const sidebarRow = (id) => `button[data-channel-id="${id}"]`;

/** test.use options: corpus channels {id: {name, count, seed, ...}}; the last
 * is the newest (the app opens it). `extra` sets the modelled read latency
 * (queryDelayMs, olderReadDelayMs) or the channel other rows reference. */
export const corpusOptions = (channels, extra) => ({
  channelIds: ["alpha", ...Object.keys(channels)],
  channelNames: Object.fromEntries(
    Object.entries(channels).map(([id, { name }]) => [id, name]),
  ),
  historyCounts: { alpha: 1 },
  corpus: {
    channels: Object.entries(channels).map(([id, channel]) => ({
      id,
      ...channel,
    })),
    reference: `#${Object.values(channels).at(-1).name}`,
    queryDelayMs: 0,
    olderReadDelayMs: 300,
    ...extra,
  },
});

export const test = base.extend({
  perf: async ({ page, app, browser }, use, testInfo) => {
    await page.addInitScript({ content: `(${installRecorder})()` });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const rate = Number(process.env.PERF_CPU ?? 4);
    const scriptMs = async () =>
      (await cdp.send("Performance.getMetrics")).metrics.find(
        (m) => m.name === "ScriptDuration",
      ).value * 1000;
    const problems = [];
    const sessions = [];
    let reported = false;
    const perf = {
      /** Unthrottled: load Messages with every font face loaded, then open `id`. */
      async setup(id) {
        await page.goto(app.origin);
        await openPage(page, "Messages");
        const unloaded = await page.evaluate(async () => {
          await Promise.allSettled([...document.fonts].map((f) => f.load()));
          return [...document.fonts].filter((f) => f.status !== "loaded")
            .length;
        });
        perf.require("every font face loaded", unloaded === 0);
        await perf.openChannel(id);
      },
      /** Open a sidebar channel with an in-page click (no hover prepare). */
      async openChannel(id) {
        await page.evaluate(
          ({ section, row }) => {
            if (!document.querySelector(section))
              document.querySelector(row).click();
          },
          { section: timeline(id), row: sidebarRow(id) },
        );
        await expect(
          page.locator(`${timeline(id)} [data-message-id]`).first(),
        ).toBeVisible();
        await settle(page, page.locator(timeline(id)));
      },
      /** Page all of `id`'s history in through the edge button, which loads
       * older rows without moving the view (so they stay unmeasured). */
      async loadAllHistory(id) {
        const scroller = page.locator(timeline(id));
        const button = scroller.locator(":scope > div:first-child button");
        const height = () =>
          scroller.evaluate((element) => element.scrollHeight);
        let pages = 0;
        for (; (await button.count()) && pages < 60; pages++) {
          await expect(button).toHaveText("Load older messages");
          const before = await height();
          await button.evaluate((element) => element.click());
          await expect.poll(height).toBeGreaterThan(before);
        }
        await expect(button).toHaveCount(0);
        return pages;
      },
      /** Mount (so measure) every loaded row once, then return to the newest. */
      async traverse(id) {
        const scroller = page.locator(timeline(id));
        const height = await scroller.evaluate(
          (element) => element.scrollHeight,
        );
        for (const dy of [height, -height]) {
          await perf.gesture({
            dy,
            speed: 6000,
            at: await perf.park(timeline(id)),
          });
          await settle(page, scroller);
        }
        await end(page);
      },
      toBottom: () => end(page),
      /** Pointer in a scroller's gutter: wheel input reaches it, no row is hovered. */
      async park(selector) {
        const { inside, ...point } = await page.evaluate((selector) => {
          const element = document.querySelector(selector);
          const box = element.getBoundingClientRect();
          const list = element
            .querySelector(":scope > ol, [data-thread-rows]")
            ?.getBoundingClientRect();
          const gutter = list ? (box.left + list.left) / 2 : box.left + 4;
          const x = Math.round(Math.max(box.left + 2, gutter));
          const y = Math.round(box.top + box.height / 2);
          return {
            x,
            y,
            inside: element.contains(document.elementFromPoint(x, y)),
          };
        }, selector);
        if (!inside) throw new Error(`Park point covered for ${selector}`);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
        });
        return point;
      },
      /** Rest the pointer on `id`'s sidebar row (the app prepares it on hover). */
      async hover(id) {
        const box = await page.locator(sidebarRow(id)).boundingBox();
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        });
      },
      /** One CDP smooth-scroll gesture; positive dy scrolls toward older rows. */
      gesture: ({ dy, speed, at }) =>
        cdp.send("Input.synthesizeScrollGesture", {
          x: at.x,
          y: at.y,
          xDistance: 0,
          yDistance: Math.round(dy),
          speed,
          gestureSourceType: "mouse",
          preventFling: true,
        }),
      /** Run `fn(arg)` in the page right after the next sample; resolves with its page-clock time. */
      act: (fn, arg) =>
        page.evaluate(
          `window.__perf.act(() => (${fn})(${JSON.stringify(arg ?? null)}))`,
        ),
      /** Wait in the page for its own quiet barrier (between gesture steps). */
      quiet: (quietMs) =>
        page.evaluate(
          (quietMs) => window.__perf.settled({ quietMs, timeoutMs: 8000 }),
          quietMs,
        ),
      /** Unmeasured: wait until the page is quiet (500ms over 10 frames with
       * no read in flight), then idle. */
      async idle(label) {
        const quiet = await page.evaluate(async () => {
          window.__perf.start();
          const { settled } = await window.__perf.settled();
          window.__perf.stop();
          await new Promise((resolve) =>
            requestIdleCallback(resolve, { timeout: 2000 }),
          );
          return settled;
        });
        perf.require(`${label}: idle`, quiet);
      },
      /** A measured window at PERF_CPU: GC and a quiet page first, then
       * `action` (no Playwright waits), the settle barrier, and a tail of at
       * least 2.5s that ends after 1s without change. `settleMs` runs from
       * the action (or the last wheel) to the last change seen in the tail. */
      async record(label, action) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        try {
          await cdp.send("HeapProfiler.collectGarbage");
          await perf.idle(`${label}: before`);
          const before = await scriptMs();
          await page.evaluate(() => window.__perf.start());
          const acted = await action();
          const settled = await page.evaluate(async () => {
            const first = await window.__perf.settled();
            const tail = await window.__perf.settled({
              quietMs: 1000,
              minMs: 2500,
            });
            return { ok: first.settled && tail.settled, last: tail.lastChange };
          });
          const cost = (await scriptMs()) - before;
          const session = await page.evaluate(() => window.__perf.stop());
          sessions.push({ label, session });
          perf.require(`${label}: settled`, settled.ok);
          perf.require(`${label}: not truncated`, !session.truncated);
          perf.require(
            `${label}: rows found`,
            !session.frames.some((f) => Object.values(f.s).some((s) => s.lost)),
          );
          const from =
            typeof acted === "number" ? acted : session.wheels.at(-1);
          return {
            session,
            from,
            scriptMs: cost,
            settleMs: settled.last - from,
          };
        } finally {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        }
      },
      /** A measured in-page click on `selector`. */
      click: (label, selector) =>
        perf.record(label, () =>
          perf.act((s) => document.querySelector(s).click(), selector),
        ),
      /** A setup or validity condition; the iteration fails if it does not hold. */
      require(name, ok, detail) {
        if (!ok) problems.push(detail == null ? name : `${name}: ${detail}`);
      },
      /** Record the tiered numbers ({targets, defects, guards, work}); a
       * missing one fails the iteration (it was not measured). */
      async result(scenario, variant, tiers) {
        for (const [tier, values] of Object.entries(tiers))
          for (const [name, value] of Object.entries(values))
            perf.require(`${tier} ${name} measured`, Number.isFinite(value));
        app.report.measurements.push({
          perf: 1,
          scenario,
          variant,
          env: {
            harness,
            browser: browser.version(),
            cpuRate: rate,
            viewport: testInfo.project.use.viewport,
            dpr: await page.evaluate(() => devicePixelRatio),
          },
          build,
          load: loadavg()[0],
          problems,
          ...tiers,
        });
        reported = true;
        if (problems.length)
          throw new Error(
            `Invalid iteration (fails closed): ${problems.join("; ")}`,
          );
      },
    };
    try {
      await use(perf);
    } finally {
      // Raw frames of a failed iteration (however it failed), or on request.
      if (!reported || problems.length || process.env.PERF_FRAMES)
        writeFileSync(
          testInfo.outputPath("frames.json"),
          JSON.stringify(sessions),
        );
    }
    if (!reported)
      throw new Error(
        `Invalid iteration (fails closed): no result. ${problems.join("; ")}`,
      );
  },
});
export { expect };
