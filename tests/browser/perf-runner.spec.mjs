import { test, expect, sidebar } from "./perf/runner.mjs";

// Real browser boundary: native trusted targeting, engine capability delivery,
// and recovery after an action rejects cannot be established by helper mocks.
test.use({ historyCounts: { alpha: 1, beta: 120 }, tallMessages: true });

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
