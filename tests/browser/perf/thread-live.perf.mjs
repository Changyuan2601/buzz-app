import { setTimeout as delay } from "node:timers/promises";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect, repeats, timeline } from "./runner.mjs";
import { settle, virtuaIdle } from "../timeline.mjs";

// Browser-only: an agent thread stays open while replies and streamed edits
// arrive through the production broker. Each arrival re-renders the thread and
// the channel row behind it; jsdom cannot show that per-arrival frame cost.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  presenceThreadAuthors: 1,
  historyCounts: { alpha: 40, beta: 1 },
});

const replyCount = 40;
const turns = 5;
const steps = 3;
const intervalMs = 200;

function populate(app) {
  const authors = Array.from({ length: 6 }, (_, i) => {
    const key = generateSecretKey();
    app.serveProfile(key, {
      name: `Live ${i < 4 ? "Agent" : "Reader"} ${i}`,
      ...(i < 4 ? { is_agent: true } : {}),
    });
    return key;
  });
  const { root, replies } = app.presenceThread;
  replies.length = 0;
  const variants = [
    "Plain text from the agent conversation.",
    "**Status** with _emphasis_, ~~removed text~~ and `inlineCode()`.",
    "Follow-ups:\n- [x] read the logs\n- [ ] rerun the job\n\n| Step | Time | Result |\n| --- | ---: | --- |\n| build | 120 ms | ready |\n| test | 80 ms | ready |",
    "```typescript\nconst results = await loadMessages({ limit: 80 });\nconsole.log(results.length);\n```",
    "> Review feedback\n\nA second paragraph explains the decision.",
    "@Live Agent 0: [Design notes](https://example.com/design) and https://example.com/review",
  ];
  for (let i = 0; i < replyCount; i++)
    replies.push(
      finalizeEvent(
        {
          kind: 9,
          created_at: root.created_at + i + 20,
          content: `Thread reply ${i}\n${variants[i % variants.length]}`,
          tags: [
            ["h", "alpha"],
            ["e", root.id, "", "reply"],
          ],
        },
        authors[i % authors.length],
      ),
    );
  // Each agent turn posts a reply, then streams two growing edits of it.
  const bodies = [
    (t) => `Live turn ${t} step 0\nLooking into the failing job now.`,
    (t) =>
      `Live turn ${t} step 1\nLooking into the failing job now.\n\n- fetched the **build log**\n- found \`exit 1\` in step test`,
    (t) =>
      `Live turn ${t} step 2\nLooking into the failing job now.\n\n- fetched the **build log**\n- found \`exit 1\` in step test\n\n\`\`\`sh\npnpm test --filter thread\n\`\`\``,
  ];
  const arrivals = [];
  for (let t = 0; t < turns; t++) {
    const author = authors[t % 4];
    const reply = finalizeEvent(
      {
        kind: 9,
        created_at: root.created_at + replyCount + 20 + t * steps,
        content: bodies[0](t),
        tags: [
          ["h", "alpha"],
          ["e", root.id, "", "reply"],
        ],
      },
      author,
    );
    const markers = (step) =>
      Array.from(
        { length: steps - step },
        (_, j) => `Live turn ${t} step ${step + j}`,
      );
    arrivals.push({
      event: reply,
      row: reply.id,
      markers: markers(0),
    });
    for (let s = 1; s < steps; s++)
      arrivals.push({
        event: finalizeEvent(
          {
            kind: 40003,
            created_at: reply.created_at + s,
            content: bodies[s](t),
            tags: [
              ["h", "alpha"],
              ["e", reply.id],
            ],
          },
          author,
        ),
        row: reply.id,
        markers: markers(s),
      });
  }
  return { root, authors, arrivals };
}

// Runs in the page. Stamps the first rendering update (rAF, before paint) at
// which each arrival's row is visible in the thread viewport with its text.
// Edits are cumulative, so a later step of the same turn also proves an earlier
// one that rendered in the same frame. One row query per frame; stops when done.
function observeArrivals({ selector, arrivals }) {
  const seen = arrivals.map(() => undefined);
  let element, raf;
  function frame() {
    const now = performance.timeOrigin + performance.now();
    if (!element?.isConnected) element = document.querySelector(selector);
    if (element) {
      const rows = new Map(
        [...element.querySelectorAll("[data-message-id]")].map((node) => [
          node.dataset.messageId,
          node,
        ]),
      );
      let bounds;
      for (const [index, { row, markers }] of arrivals.entries()) {
        const node = rows.get(row);
        if (seen[index] !== undefined || !node) continue;
        const text = node.textContent;
        if (!markers.some((marker) => text.includes(marker))) continue;
        bounds ??= element.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        if (
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          node.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          })
        )
          seen[index] = now;
      }
    }
    if (seen.includes(undefined)) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return {
    seen: () => seen,
    stop: () => cancelAnimationFrame(raf),
  };
}

const wallMs = () => performance.timeOrigin + performance.now();
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

for (let i = 1; i <= repeats; i++)
  test(`thread-reply-live sample ${i}`, async ({ page, app, perf }) => {
    const { root, authors, arrivals } = populate(app);
    await perf.setup("alpha");
    const participants = authors.map(getPublicKey);
    const summaryAt = Math.floor(Date.now() / 1000) + 1;
    app.threadSummary(root.id, participants, replyCount, summaryAt);
    const channel = page.locator(timeline("alpha"));
    const trigger = channel
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole("button", { name: `View thread: ${replyCount} replies` });
    await trigger.scrollIntoViewIfNeeded();
    await virtuaIdle(page, channel);
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = thread.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await trigger.click();
    await expect(history).not.toHaveAttribute("data-positioning");
    await expect(history.locator("[data-message-id]")).toHaveCount(
      replyCount + 1,
    );
    await expect(
      history.getByText(`Thread reply ${replyCount - 1}`, { exact: false }),
    ).toBeInViewport();
    await expect(
      page.locator("[data-channel-workspace] > [data-panel-dock]"),
    ).toBeVisible();
    await settle(page, history);
    await virtuaIdle(page, channel);
    const channelRows = await channel.locator("[data-message-id]").count();
    expect(channelRows, "channel timeline stays mounted").toBeGreaterThan(0);
    // The reader watches the stream: the pointer rests over the thread, not on
    // the channel trigger the setup click left it on.
    const historySelector =
      '[data-channel-workspace] [aria-label="Thread messages"]';
    const streamView = page.locator(historySelector);
    const point = await streamView.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
      };
    });
    await perf.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
    });
    const hovered = await streamView.evaluate((element, { x, y }) => {
      const row = document.elementFromPoint(x, y)?.closest("[data-message-id]");
      return element.contains(row) ? row.dataset.messageId : undefined;
    }, point);
    expect(hovered, "pointer rests on a thread reply").toBeDefined();
    await settle(page, streamView);

    // Page and Node read the same host wall clock; a round trip bounds the skew.
    const t0 = wallMs();
    const pageNow = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    const t1 = wallMs();
    const clock = {
      offsetMs: pageNow - (t0 + t1) / 2,
      uncertaintyMs: (t1 - t0) / 2,
    };

    const expected = arrivals.map(({ row, markers }) => ({ row, markers }));
    const arrivalsObserver = await page.evaluateHandle(observeArrivals, {
      selector: historySelector,
      arrivals: expected,
    });
    const emitted = [];
    try {
      const sample = await perf.measure("alpha", {
        timeoutMs: 20_000,
        async act() {
          // A Node clock drives arrivals; UI progress never paces the stream.
          const start = performance.now();
          for (const [index, { event }] of arrivals.entries()) {
            await delay(
              Math.max(0, start + index * intervalMs - performance.now()),
            );
            emitted.push(wallMs() + clock.offsetMs);
            app.relay.publish("primary", event);
            if (event.kind !== 9) continue;
            // The relay republishes the root's summary with each reply.
            const { replies } = app.presenceThread;
            replies.push(event);
            app.threadSummary(
              root.id,
              participants,
              replies.length,
              summaryAt + replies.length - replyCount,
            );
          }
          await expect
            .poll(() =>
              arrivalsObserver.evaluate((o) =>
                o.seen().every((value) => value !== undefined),
              ),
            )
            .toBe(true);
          await settle(page, streamView);
        },
        work: {
          replyCount,
          arrivals: arrivals.length,
          newReplies: turns,
          streamedEdits: turns * (steps - 1),
          intervalMs,
          channelRows,
          pointer: { ...point, hovered },
          clock,
        },
      });
      const seen = await arrivalsObserver.evaluate((o) => o.seen());
      const latencies = seen.map((value, index) => value - emitted[index]);
      sample.work.latenciesMs = latencies;
      sample.work.emittedMs = emitted.map((value) => value - emitted[0]);
      // Final DOM: every streamed row shows its last edit and only that.
      sample.work.finalRows = await history.evaluate(
        (element, ids) =>
          ids.map((id) => {
            const text =
              element.querySelector(`[data-message-id="${id}"]`)?.textContent ??
              "";
            return {
              id,
              final: /Live turn \d step 2/.test(text),
              stale: /Live turn \d step [01]/.test(text),
            };
          }),
        arrivals.filter(({ event }) => event.kind === 9).map(({ row }) => row),
      );
      sample.work.threadRows = await history
        .locator("[data-message-id]")
        .count();
      const kinds = (kind) =>
        latencies.filter((_, index) => arrivals[index].event.kind === kind);
      sample.metrics.replyLatencyP50Ms = percentile(kinds(9), 0.5);
      sample.metrics.editLatencyP50Ms = percentile(kinds(40003), 0.5);
      sample.metrics.arrivalLatencyP50Ms = percentile(latencies, 0.5);
      sample.metrics.arrivalLatencyP95Ms = percentile(latencies, 0.95);
      sample.metrics.taskMsPerArrival = sample.metrics.taskMs / arrivals.length;
      sample.metrics.scriptMsPerArrival =
        sample.metrics.scriptMs / arrivals.length;
      await perf.save(sample);
      expect(emitted).toHaveLength(arrivals.length);
      expect(
        latencies.every((value) => Number.isFinite(value) && value > 0),
        "every arrival became visible after its emission",
      ).toBe(true);
      expect(sample.work.threadRows).toBe(replyCount + 1 + turns);
      expect(sample.work.finalRows).toEqual(
        sample.work.finalRows.map(({ id }) => ({
          id,
          final: true,
          stale: false,
        })),
      );
      await expect(
        channel.locator(`[data-message-id="${root.id}"]`).getByRole("button", {
          name: `View thread: ${replyCount + turns} replies`,
        }),
        "channel row behind the panel counts the live replies",
      ).toBeAttached();
    } finally {
      await arrivalsObserver.evaluate((o) => o.stop());
      await arrivalsObserver.dispose();
    }
  });
