import { test, expect } from "../playwright-test.mjs";
import { recordEditor } from "./editor-recorder.mjs";

// Calibration runs alongside the benchmarks, never as a product speed gate.
// The browser boundary proves input queueing, final-key work and late results.
test("editor-probe sample 1", async ({ page, browserName }, testInfo) => {
  await page.setContent(
    '<form><textarea aria-label="Probe"></textarea></form>',
  );
  const input = page.getByRole("textbox", { name: "Probe" });
  await input.focus();
  await input.evaluate((element) => {
    element.addEventListener("keydown", (event) => {
      // Real clock: measured work, not synchronization. Both the first and last
      // key block; externally scheduled input must keep arriving meanwhile.
      if (event.key === "a" || event.key === "c") {
        const until = performance.now() + (event.key === "c" ? 240 : 120);
        while (performance.now() < until) {
          /* calibrated main-thread work */
        }
      }
      if (event.key === "c") {
        setTimeout(() => {
          const list = document.createElement("div");
          list.id = "probe-results";
          list.innerHTML =
            '<div role="option"><span data-completion-label><span>Available</span></span></div>';
          document.body.append(list);
          element.setAttribute("aria-controls", list.id);
        }, 800);
      }
    });
  });
  const actions = [
    { key: "a", phase: "typing", text: "a" },
    { key: "b", phase: "typing", text: "ab" },
    { key: "c", phase: "suggestions", text: "abc", options: ["Available"] },
  ];
  const sample = await recordEditor({
    page,
    input,
    actions,
    identities: [],
    intervalMs: 20,
    expected: { text: "abc", options: ["Available"] },
    browserName,
    cpu: 1,
  });
  await testInfo.attach("perf-sample", {
    body: JSON.stringify(sample),
    contentType: "application/json",
  });
  expect(sample.recording.inputReceipt).toMatchObject({
    expected: 3,
    observed: 3,
    trusted: true,
    ordered: true,
    misdirected: 0,
  });
  expect(sample.recording.endpoint).toBe("observed");
  expect(sample.metrics.activeRafGapMaxMs).toBeGreaterThanOrEqual(240);
  expect(sample.metrics.suggestionsStateMaxMs).toBeGreaterThanOrEqual(800);
  expect(sample.metrics.inputQueueMaxMs).toBeGreaterThanOrEqual(50);
  expect(
    sample.dispatch.receipts[2].sentMs - sample.dispatch.receipts[0].sentMs,
  ).toBeLessThan(120);
});
