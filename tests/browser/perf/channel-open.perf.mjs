import { test, expect, heads, repeats, sidebar } from "./runner.mjs";

test.use({ historyCounts: { alpha: 1, beta: 120 }, tallMessages: true });
for (const mode of ["cold", "hover"]) {
  for (let i = 1; i <= repeats; i++) {
    test(`channel-open-${mode} sample ${i}`, async ({ app, perf }) => {
      await perf.setup("alpha");
      expect(
        heads(app, "beta"),
        "target has never been opened or prepared",
      ).toBe(0);
      const hoverMs = mode === "hover" ? 150 : 0;
      const sample = await perf.measure("beta", {
        click: sidebar("beta"),
        hoverMs,
        work: { mode, hoverMs },
      });
      await perf.save(sample);
      if (mode === "cold")
        expect(sample.work.headReadsDuring).toBeGreaterThan(0);
      else expect(sample.recording.hoverLeadMs).toBeGreaterThanOrEqual(hoverMs);
      expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
    });
  }
}
