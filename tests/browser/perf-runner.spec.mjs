import { test, expect, sidebar } from "./perf/runner.mjs";

// Real browser boundary: native trusted targeting, engine capability delivery,
// and recovery after an action rejects cannot be established by helper mocks.
test.use({
  historyCounts: { alpha: 1, beta: 120 },
  tallMessages: true,
  channelWork: true,
});

test("main recorder retains aborted native input and recovers with engine metrics", async ({
  page,
  app,
  perf,
  browserName,
}) => {
  await perf.setup("alpha");
  await expect(
    perf.measure("beta", {
      click: sidebar("beta"),
      act: () => {
        throw new Error("intentional action failure");
      },
    }),
  ).rejects.toThrow("intentional action failure");
  const interrupted = app.report.measurements.at(-1);
  expect(interrupted.recording.error).toBe("Measurement interrupted");
  const click = interrupted.recording.inputs?.find(
    (event) => event.type === "click",
  );
  if (browserName === "webkit")
    expect(click).toMatchObject({
      trusted: true,
      target: true,
      channel: "beta",
    });
  const sample = await perf.measure("alpha", {
    act: () => page.locator(sidebar("alpha")).click(),
  });
  expect(sample.recording.error).toBeUndefined();
  expect(sample.metrics.durationMs).toBeGreaterThanOrEqual(200);
  expect(sample.recording.frames.length).toBeGreaterThanOrEqual(3);
  if (browserName === "webkit")
    expect(
      sample.recording.inputs?.filter(({ type }) => type === "click"),
    ).toHaveLength(1);
  for (const metric of [
    "scriptMs",
    "layoutMs",
    "styleMs",
    "taskMs",
    "loafBlockingMs",
  ])
    if (browserName === "chromium")
      expect(sample.metrics[metric]).toBeGreaterThanOrEqual(0);
    else {
      expect(sample.metrics).not.toHaveProperty(metric);
      expect(sample.apparatus.unavailable[metric]).toBeTruthy();
    }
});

test("missing LoAF rejects Chromium without inventing a WebKit counter", async ({
  page,
  perf,
  browserName,
}) => {
  await perf.setup("alpha");
  await page.evaluate(() => {
    Object.defineProperty(PerformanceObserver, "supportedEntryTypes", {
      value: [],
      configurable: true,
    });
  });
  // A fresh test page owns this capability mutation; no production seam.
  if (browserName === "chromium")
    await expect(perf.measure("alpha", {})).rejects.toThrow(
      "does not support long-animation-frame",
    );
  else {
    const sample = await perf.measure("alpha", {});
    expect(sample.metrics).not.toHaveProperty("loafBlockingMs");
    expect(sample.recording).not.toHaveProperty("longAnimationFrames");
  }
});

// Real signed HTTP envelopes can be incomplete while still rendering valid
// rows. The response oracle, not the virtualized mounted-row count, must reject.
for (const fault of ["missing-latest", "latest-only", "partial", "wrong-head"])
  test(`channel work rejects signed ${fault} head at the original endpoint`, async ({
    page,
    app,
    perf,
  }) => {
    const history = app.histories.get("primary/beta");
    await page.route("**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (
        !filters.some(
          (f) =>
            f.top_level && f.until === undefined && f["#h"]?.includes("beta"),
        )
      )
        return route.fallback();
      const response = await route.fetch();
      const events = await response.json();
      const json =
        fault === "wrong-head"
          ? [
              ...history.slice(80, 100).toReversed(),
              app.signRelay({
                kind: 39006,
                created_at: 1700000000,
                tags: [
                  ["h", "beta"],
                  ["d", "beta:head"],
                ],
                content: JSON.stringify({
                  has_more: true,
                  next_cursor: {
                    created_at: history[80].created_at,
                    id: history[80].id,
                  },
                }),
              }),
            ]
          : events.filter(
              (e) =>
                e.kind !== 9 ||
                (fault === "missing-latest"
                  ? e.id !== history[119].id
                  : e.id === history[fault === "latest-only" ? 119 : 118].id),
            );
      await route.fulfill({ response, json });
    });
    await perf.setup("alpha");
    await expect(
      perf.measure("beta", { click: sidebar("beta") }),
    ).rejects.toThrow("fixture-owned exact signed head20 membership");
    const sample = app.report.measurements.at(-1);
    expect(sample.work.channel.expectedIds).toEqual(
      history.slice(100).map((e) => e.id),
    );
    expect(sample.recording.error).toBeUndefined();
  });

for (const intent of ["pointer", "focus"])
  test(`channel cold retains prior ${intent} and a request held before fixture dispatch`, async ({
    page,
    app,
    perf,
  }) => {
    let release, observed;
    const gate = new Promise((r) => {
      release = r;
    });
    const requested = new Promise((r) => {
      observed = r;
    });
    await page.route("**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (
        filters.some(
          (f) =>
            f.top_level && f.until === undefined && f["#h"]?.includes("beta"),
        )
      ) {
        observed();
        await gate;
      }
      await route.fallback();
    });
    try {
      await perf.setup("alpha");
      const target = page.locator(sidebar("beta"));
      if (intent === "pointer") await target.hover();
      else await target.focus();
      await requested;
      if (intent === "pointer") await page.locator(sidebar("alpha")).hover();
      else await page.locator(sidebar("alpha")).focus();
      expect(
        app.report.queries.filter(
          ({ filter }) => filter.top_level && filter["#h"]?.includes("beta"),
        ),
      ).toHaveLength(0);
      await expect(
        perf.measure("beta", { click: sidebar("beta"), act: () => release() }),
      ).rejects.toThrow(
        "channel target has no prior intent or in-flight preparation",
      );
      const failed = app.report.measurements.at(-1);
      const frozen = JSON.stringify(failed);
      const recovered = await perf.measure("alpha", {
        act: () => page.locator(sidebar("alpha")).click(),
      });
      expect(recovered.work).not.toHaveProperty("channel");
      expect(JSON.stringify(failed)).toBe(frozen);
    } finally {
      release();
    }
  });

for (const fault of ["hidden", "wrong-text"])
  test(`channel visible-content oracle rejects ${fault} latest body`, async ({
    page,
    app,
    perf,
  }) => {
    await perf.setup("alpha");
    await expect(
      perf.measure("beta", {
        click: sidebar("beta"),
        act: async () => {
          const body = page
            .locator(
              `[data-message-id="${app.histories.get("primary/beta")[119].id}"] [data-message-action-anchor]`,
            )
            .first();
          await expect(body).toBeVisible();
          await body.evaluate((e, fault) => {
            if (fault === "hidden") e.style.visibility = "hidden";
            else e.textContent = "wrong source content";
          }, fault);
        },
      }),
    ).rejects.toThrow(
      fault === "hidden"
        ? "required latest content visible"
        : "source-derived visible latest content",
    );
  });
