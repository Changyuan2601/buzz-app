import { test, expect, repeats, timeline, sidebar } from "../perf/runner.mjs";
import { virtuaIdle, settle } from "../timeline.mjs";

const channels = ["alpha", "beta", "gamma", "delta"];
const checkpoints = [0, 25, 100];
const draft = (id) => `Retain the ${id} draft while navigating.`;
const threadDraft = (index) => `Retain thread ${index}'s reply draft.`;
const counterNames = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  channelIds: channels,
  historyCounts: { alpha: 40, beta: 40, gamma: 40, delta: 40 },
  markdownMessages: true,
});

for (let repeat = 1; repeat <= repeats; repeat++)
  test(`repeat-navigation sample ${repeat}`, async ({ page, app, perf }) => {
    const roots = app.histories
      .get("primary/alpha")
      .filter((event) => event.content.startsWith("Thread root "));
    expect(roots).toHaveLength(2);
    for (const [index, root] of roots.entries())
      app.threadReplies.set(
        root.id,
        Array.from({ length: 6 }, (_, reply) =>
          app.sign({
            kind: 9,
            created_at: root.created_at + 20 + reply,
            content: `Navigation thread ${index} reply ${reply}: **review** and discussion.`,
            tags: [
              ["h", "alpha"],
              ["e", root.id, "", "reply"],
            ],
          }),
        ),
      );

    const inflight = new Set();
    const requested = (request) => {
      if (new URL(request.url()).pathname.match(/\/api\/relay\/[^/]+\/query$/))
        inflight.add(request);
    };
    const finished = (request) => inflight.delete(request);
    page.on("request", requested);
    page.on("requestfinished", finished);
    page.on("requestfailed", finished);
    const cpu = Number(process.env.PERF_CPU);
    const throttle = () =>
      perf.cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const readCounters = async () => {
      const { metrics } = await perf.cdp.send("Performance.getMetrics");
      return Object.fromEntries(
        Object.entries(counterNames).map(([key, name]) => [
          key,
          metrics.find((metric) => metric.name === name).value * 1000,
        ]),
      );
    };
    const difference = (before, after) =>
      Object.fromEntries(
        Object.keys(before).map((key) => [key, after[key] - before[key]]),
      );
    const channelInput = (id) =>
      page.getByRole("textbox", {
        name: `Message #${id[0].toUpperCase()}${id.slice(1)}`,
        exact: true,
      });
    const thread = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const closeTabs = page.locator('[role="tab"][data-tab-value^="thread:"]');
    const noThreads = async () => {
      await expect(closeTabs).toHaveCount(0);
      await expect(thread).toHaveCount(0);
    };
    const selected = async (id) => {
      await page.locator(sidebar(id)).click();
      const history = page.locator(timeline(id));
      await expect(history.locator("[data-message-id]").first()).toBeVisible();
      await expect(channelInput(id)).toBeEditable();
      await virtuaIdle(page, history);
      await expect
        .poll(() => inflight.size, { message: "finite relay reads complete" })
        .toBe(0);
    };
    const edit = async (input, value, initialize) => {
      if (initialize) await input.fill(value);
      await expect(input).toHaveText(value);
      await input.press("End");
      await input.press("x");
      await expect(input).toHaveText(`${value}x`);
      await input.press("Backspace");
      await expect(input).toHaveText(value);
    };
    const messagePublications = () =>
      app.report.publications.filter(({ event }) =>
        [9, 40002, 40008].includes(event.kind),
      ).length;
    const transport = () => {
      const sockets = app.relay.sockets.filter(
        (socket) => socket.readyState === 1,
      );
      return {
        activeSockets: sockets.length,
        activeWires: sockets.reduce(
          (sum, socket) => sum + socket.routes.size,
          0,
        ),
        filters: sockets.flatMap((socket) =>
          [...socket.routes.values()].flat(),
        ),
        queries: app.report.queries.length,
        threadQueries: app.report.queries.filter(
          ({ filter }) => filter.depth_limit,
        ).length,
        liveRequests: app.report.liveRequests?.length ?? 0,
        messagePublications: messagePublications(),
        typingPublications: app.report.typingPublications.length,
        readPublications: app.report.readPublications.length,
      };
    };
    const established = async () => {
      await expect
        .poll(() => channels.every((id) => app.relay.hasRoute("primary", id)))
        .toBe(true);
      await expect
        .poll(
          () => {
            const eose = new Set(
              app.report.wireFrames
                .filter(([kind]) => kind === "EOSE")
                .map(([, id]) => id),
            );
            return app.relay.sockets
              .filter((socket) => socket.readyState === 1)
              .every((socket) =>
                [...socket.routes.keys()].every((id) => eose.has(id)),
              );
          },
          { message: "current live wires reached EOSE" },
        )
        .toBe(true);
      await expect.poll(() => inflight.size).toBe(0);
    };
    const resources = async () => {
      const dom = await perf.cdp.send("Memory.getDOMCounters");
      const { metrics } = await perf.cdp.send("Performance.getMetrics");
      return {
        dom,
        heapUsedBytes: metrics.find(({ name }) => name === "JSHeapUsedSize")
          .value,
        heapTotalBytes: metrics.find(({ name }) => name === "JSHeapTotalSize")
          .value,
        transport: transport(),
        limitation:
          "No forced GC. Counts include unreachable garbage; wires do not count internal JS subscriptions.",
      };
    };
    const cycleReceipts = [];
    async function cycle(index, initialize = false) {
      const began = performance.now();
      const before = transport();
      await selected("alpha");
      await edit(channelInput("alpha"), draft("alpha"), initialize);
      const channel = page.locator(timeline("alpha"));
      const width = await channel.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      for (const [rootIndex, root] of roots.entries()) {
        const trigger = channel
          .locator(`[data-message-id="${root.id}"]`)
          .getByRole("button", { name: /^View thread:/ });
        await trigger.click();
        await expect(thread).not.toHaveAttribute("data-positioning");
        await expect(thread.locator("[data-message-id]")).toHaveCount(7);
        for (const reply of app.threadReplies.get(root.id))
          await expect(
            thread.locator(`[data-message-id="${reply.id}"]`),
          ).toBeAttached();
        const input = page.getByRole("textbox", {
          name: "Reply to thread",
          exact: true,
        });
        await edit(input, threadDraft(rootIndex), initialize);
        await settle(page, thread);
        // Close the actual tab, not the pane-hiding control that retains open tabs.
        await page
          .locator(
            `.buzz-tabs-item:has([data-tab-value="thread:alpha:${root.id}"]) > button:not([role="tab"])`,
          )
          .click();
        await noThreads();
        await expect
          .poll(() =>
            channel.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          )
          .toBe(width);
        await virtuaIdle(page, channel);
      }
      for (const id of channels.slice(1)) {
        await selected(id);
        await edit(channelInput(id), draft(id), initialize);
      }
      await selected("alpha");
      await noThreads();
      expect(messagePublications()).toBe(0);
      return {
        index,
        wallMs: performance.now() - began,
        channelSelections: ["alpha", "beta", "gamma", "delta", "alpha"],
        openedAndClosedRoots: roots.map((root) => root.id),
        reversibleDraftEdits: 6,
        threadTabsAtEnd: 0,
        before,
        after: transport(),
      };
    }

    try {
      const setupStarted = performance.now();
      await throttle();
      await perf.setup("alpha");
      for (const root of roots)
        app.threadSummary(
          root.id,
          [root.pubkey],
          app.threadReplies.get(root.id).length,
        );
      const warmup = await cycle("warmup", true);
      await established();
      const setupMs = performance.now() - setupStarted;
      const samples = [];
      const segments = [];
      let completed = 0;
      let targetRows;
      for (const checkpoint of checkpoints) {
        if (checkpoint > completed) {
          const began = performance.now();
          const before = await readCounters();
          while (completed < checkpoint)
            cycleReceipts.push(await cycle(++completed));
          segments.push({
            from: segments.at(-1)?.to ?? 0,
            to: checkpoint,
            wallMs: performance.now() - began,
            counters: difference(before, await readCounters()),
          });
        }
        const conditioningStarted = performance.now();
        await selected("beta");
        await expect(channelInput("beta")).toHaveText(draft("beta"));
        await selected("alpha");
        await noThreads();
        await established();
        await perf.gutter("alpha", "pointer");
        await virtuaIdle(page, page.locator(timeline("alpha")));
        const before = await resources();
        const conditioningMs = performance.now() - conditioningStarted;
        const sample = await perf.measure("beta", {
          click: sidebar("beta"),
          work: { checkpoint },
        });
        await throttle();
        expect(
          sample.work.headReadsDuring,
          "every scored action is the same warm-cache open",
        ).toBe(0);
        await expect(channelInput("beta")).toHaveText(draft("beta"));
        const rows = await page
          .locator(`${timeline("beta")} [data-message-id]`)
          .evaluateAll((elements) =>
            elements.map((element) => element.dataset.messageId),
          );
        targetRows ??= rows;
        expect(
          rows,
          "identical mounted target head at each checkpoint",
        ).toEqual(targetRows);
        await noThreads();
        expect(messagePublications()).toBe(0);
        samples.push({
          checkpoint,
          conditioningMs,
          before,
          after: await resources(),
          ...sample,
        });
        await selected("alpha");
      }
      expect(completed).toBe(100);
      expect(cycleReceipts).toHaveLength(100);
      const metrics = Object.fromEntries(
        samples.flatMap((sample) =>
          Object.entries(sample.metrics).map(([key, value]) => [
            `cycle${sample.checkpoint}_${key}`,
            value,
          ]),
        ),
      );
      await perf.save({
        state: app.report.state,
        metrics,
        work: {
          scenario: "repeat-navigation",
          checkpoints,
          cpuDuringAging: cpu,
          setupMs,
          warmup,
          segments,
          cycleReceipts,
          samples,
          countedCycles: completed,
          targetRows,
          cumulativeCycleWallMs: segments.reduce(
            (sum, segment) => sum + segment.wallMs,
            0,
          ),
          messagePublications: messagePublications(),
        },
      });
    } finally {
      page.off("request", requested);
      page.off("requestfinished", finished);
      page.off("requestfailed", finished);
    }
  });
