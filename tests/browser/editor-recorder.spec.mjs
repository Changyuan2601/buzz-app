import { test, expect } from "./playwright-test.mjs";
import { recordEditor } from "./perf/editor-recorder.mjs";

// A real browser proves the recorder retains native input while a scenario's
// required async work is held. Pure metric tests cannot exercise this boundary.
for (const outcome of ["resolve", "reject"])
  test(`editor recorder retains a required-work boundary: ${outcome}`, async ({
    page,
    browserName,
  }) => {
    await page.setContent(
      '<form><textarea aria-label="Recorder boundary"></textarea></form>',
    );
    const input = page.getByRole("textbox", { name: "Recorder boundary" });
    await input.focus();
    let release, reject;
    const operation = new Promise((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let started = false,
      finished = false;
    const running = recordEditor({
      page,
      input,
      browserName,
      cpu: 1,
      intervalMs: 40,
      identities: [],
      actions: [{ key: "a", phase: "typing", text: "a", selection: [1, 1] }],
      expected: { text: "a", selection: [1, 1] },
      afterInput: () => {
        started = true;
        return operation;
      },
    }).then((sample) => {
      finished = true;
      return sample;
    });
    try {
      await expect.poll(() => started).toBe(true);
      await expect(input).toHaveValue("a");
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      expect(finished).toBe(false);
      if (outcome === "reject")
        reject(new Error("Intentional required-work failure"));
      else release();
    } finally {
      release();
      await Promise.allSettled([running]);
    }
    const sample = await running;
    expect(sample.recording.final).toMatchObject({
      text: "a",
      selection: [1, 1],
      focused: true,
    });
    expect(sample.recording.inputReceipt).toEqual({
      expected: 1,
      observed: 1,
      trusted: true,
      ordered: true,
      misdirected: 0,
    });
    if (outcome === "reject")
      expect(sample.recording.boundaryError).toContain(
        "Intentional required-work failure",
      );
    else expect(sample.recording.boundaryError).toBeUndefined();
    // A later recording in the same context uses the unchanged default path.
    await input.fill("");
    const recovered = await recordEditor({
      page,
      input,
      browserName,
      cpu: 1,
      intervalMs: 40,
      identities: [],
      actions: [{ key: "b", phase: "typing", text: "b", selection: [1, 1] }],
      expected: { text: "b", selection: [1, 1] },
    });
    expect(recovered.recording.final.text).toBe("b");
    expect(recovered.recording.boundaryError).toBeUndefined();
    expect(recovered.recording.inputReceipt).toMatchObject({
      observed: 1,
      trusted: true,
      ordered: true,
      misdirected: 0,
    });
  });
