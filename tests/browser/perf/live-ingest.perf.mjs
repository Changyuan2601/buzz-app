import { setTimeout as delay } from "node:timers/promises";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { arrivalLatencies, latencySummary } from "./arrivals.mjs";
import { scrollCadence } from "./cadence.mjs";
import { test as base, expect, repeats, timeline } from "./runner.mjs";

// The reader stays at the bottom of an open channel while other members'
// signed messages traverse the production broker on an external schedule.
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  livePeople: async ({}, use) => {
    await use(
      ["Rowan Park", "Priya Shah", "Mateo Ruiz", "Lena Okafor"].map((name) => {
        const key = generateSecretKey();
        return { name, key, pubkey: getPublicKey(key) };
      }),
    );
  },
  sessionMembers: async ({ livePeople }, use) => {
    await use({ alpha: livePeople.map(({ pubkey }) => pubkey) });
  },
});
const count = 20;
// Fixed 150-250ms spacing and author runs, so continuations and new author
// groups both occur. Four messages mention the viewer.
const intervals = Array.from(
  { length: count },
  (_, i) => 150 + ((i * 7) % 11) * 10,
);
const authors = [0, 0, 1, 2, 2, 2, 3, 1, 0, 3, 3, 1, 2, 0, 0, 1, 3, 2, 1, 0];
const bodies = [
  (i) => `Quick update ${i}: the staging deploy is green again.`,
  (i) =>
    `Following up on retry spike ${i}. It lines up with the cache eviction we saw last week, so I think the fix is to warm the pool before the cutover rather than after it.`,
  (i) =>
    `**Heads up:** \`relay.publish\` now batches frames; _please_ rerun your checks (${i}).`,
  (i) => `@Fixture Reader can you sign off on item ${i} before standup?`,
  (i) =>
    `Checklist ${i}:\n- confirm the migration\n- rotate the token\n- update the runbook`,
  (i) =>
    `Notes are in [the incident doc](https://example.com/incidents/${i}) and https://example.com/dash/${i}`,
  (i) =>
    `\`\`\`ts\nconst batch = await queue.take(${i});\nawait flush(batch);\n\`\`\``,
  (i) => `> Did we ever close out ${i}?\n\nYes, merged this morning.`,
  (i) => `Sounds good, picking up ${i} after lunch.`,
  (i) => `Thanks @Fixture Reader, ${i} is fixed on my side.`,
];
// Node and page monotonic clocks differ by an offset; take the round trip with
// the smallest uncertainty. Throttling is off here, outside the measurement.
async function pageClock(page) {
  let best;
  for (let i = 0; i < 5; i++) {
    const before = performance.now();
    const pageNow = await page.evaluate(() => performance.now());
    const after = performance.now();
    if (!best || after - before < best.errorMs * 2)
      best = {
        offsetMs: pageNow - (before + after) / 2,
        errorMs: (after - before) / 2,
      };
  }
  return best;
}

test.describe("live-ingest", () => {
  test.use({
    productionBroker: true,
    readState: true,
    historyCounts: { alpha: 120, beta: 1 },
    markdownMessages: true,
  });
  for (let i = 1; i <= repeats; i++)
    test(`live-ingest sample ${i}`, async ({ page, app, perf, livePeople }) => {
      for (const person of livePeople)
        app.serveProfile(person.key, { name: person.name });
      await perf.setup("alpha");
      const scroller = page.locator(timeline("alpha"));
      // Pointer modality: a real press in the gutter, as reading a channel does.
      await perf.gutter("alpha", "pointer");
      await perf.settle("alpha");
      const before = await scroller.evaluate((element) => ({
        gapPx: element.scrollHeight - element.scrollTop - element.clientHeight,
        mountedRows: element.querySelectorAll("[data-message-id]").length,
      }));
      expect(before.gapPx, "reader starts at the bottom").toBeLessThanOrEqual(
        2,
      );
      // Sign now with planned send times, as real clients stamp messages, so the
      // runner's row observer knows these IDs. Only publish() delivers them.
      const history = app.histories.get("primary/alpha");
      const leadMs = 100;
      const planned = [];
      const first = Date.now() + leadMs;
      let offsetMs = 0;
      for (let n = 0; n < count; n++) {
        const body = bodies[n % bodies.length](n);
        const at = first + offsetMs;
        const event = finalizeEvent(
          {
            kind: 9,
            created_at: Math.floor(at / 1000),
            content: body,
            tags: [
              ["h", "alpha"],
              ["ms", String(at % 1000)],
              ...(body.includes("@Fixture Reader") ? [["p", app.viewer]] : []),
            ],
          },
          livePeople[authors[n]].key,
        );
        history.push(event);
        planned.push({ event, plannedMs: offsetMs });
        offsetMs += intervals[n];
      }
      const clock = await pageClock(page);
      const headsBefore = app.report.queries.length;
      const emits = [];
      const sample = await perf.measure("alpha", {
        // Emission follows a real Node clock, never page timers or UI success.
        act: async () => {
          const start = performance.now();
          for (const { event, plannedMs } of planned) {
            await delay(Math.max(0, start + plannedMs - performance.now()));
            const emitMs = performance.now();
            app.relay.publish("primary", event);
            emits.push({
              id: event.id,
              plannedMs,
              emitMs: emitMs - start,
              at: emitMs,
            });
          }
          // Observable completion barrier: the newest arrival is in view.
          await expect(
            scroller.locator(`[data-message-id="${planned.at(-1).event.id}"]`),
          ).toBeInViewport();
        },
        work: {
          messages: count,
          mentions: planned.filter(({ event }) =>
            event.tags.some(([k, v]) => k === "p" && v === app.viewer),
          ).length,
          authors: livePeople.length,
          historyCount: 120,
          mountedRowsBefore: before.mountedRows,
          clockErrorMs: clock.errorMs,
        },
      });
      const { frames } = sample.recording;
      const arrivals = arrivalLatencies(
        sample.recording,
        emits,
        clock.offsetMs,
      );
      const latencies = arrivals
        .map(({ latencyMs }) => latencyMs)
        .filter(Number.isFinite);
      const after = await scroller.evaluate((element) => {
        const rows = [...element.querySelectorAll("[data-message-id]")];
        return {
          gapPx:
            element.scrollHeight - element.scrollTop - element.clientHeight,
          jumpVisible: element.hasAttribute("data-jump-visible"),
          selfMentions: element.querySelectorAll(
            `[data-mention-self][data-mention-kind="person"]`,
          ).length,
          lastRowId: rows.at(-1)?.dataset.messageId,
        };
      });
      const ids = new Set(planned.map(({ event }) => event.id));
      const lastFrameIds = frames.at(-1).rows.map(([id]) => id);
      // Browser counters are Chromium-only; WebKit samples omit the ratios.
      if (sample.metrics.taskMs !== undefined)
        Object.assign(sample.metrics, {
          taskMsPerMessage: sample.metrics.taskMs / count,
          scriptMsPerMessage: sample.metrics.scriptMs / count,
        });
      Object.assign(sample.metrics, {
        ...latencySummary(arrivals),
        ...scrollCadence({
          frames,
          gestureStartMs: arrivals[0].emitT,
          gestureEndMs: Math.max(
            ...arrivals.map(({ visibleT }) => visibleT ?? 0),
          ),
        }),
      });
      Object.assign(sample.work, {
        emits,
        arrivals,
        arrivalsVisible: latencies.length,
        emitSpanMs: emits.at(-1).emitMs - emits[0].emitMs,
        // Any read after setup could deliver the pre-signed rows outside live.
        readsDuring: app.report.queries
          .slice(headsBefore)
          .filter(
            ({ filter }) =>
              filter?.["#h"]?.includes("alpha") && filter.kinds?.includes(9),
          ).length,
        followGapPx: after.gapPx,
        jumpVisible: after.jumpVisible,
        selfMentionsRendered: after.selfMentions,
        lastRowIsNewest: after.lastRowId === planned.at(-1).event.id,
        newestInLastFrame: lastFrameIds.includes(planned.at(-1).event.id),
        arrivalsInLastFrame: lastFrameIds.filter((id) => ids.has(id)).length,
      });
      await perf.save(sample);
      // Work receipts: every message was delivered live, rendered in view after
      // its emission, and the reader still follows the newest message.
      expect(sample.work.arrivalsVisible, "every arrival became visible").toBe(
        count,
      );
      expect(
        Math.min(...latencies),
        "rows appear only after their live emission",
      ).toBeGreaterThan(-clock.errorMs);
      expect(sample.work.readsDuring, "delivery is live, not a re-read").toBe(
        0,
      );
      expect(
        sample.work.followGapPx,
        "reader still at the bottom",
      ).toBeLessThanOrEqual(2);
      expect(sample.work.jumpVisible, "follow kept; no jump button").toBe(
        false,
      );
      expect(sample.work.lastRowIsNewest).toBe(true);
      expect(sample.work.newestInLastFrame).toBe(true);
      expect(
        sample.work.selfMentionsRendered,
        "viewer mentions render as self mentions",
      ).toBeGreaterThanOrEqual(sample.work.mentions);
    });
});
