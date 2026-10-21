import { expect, it, vi } from "vitest";
import { createSetup, type SetupStep } from "./setup";

const ok = (label: string): SetupStep => ({
  label,
  run: vi.fn(() => Promise.resolve()),
});
/** Fails until `heal`, with a retryable error when asked. */
function flaky(
  label: string,
  retryable: boolean,
  fallback?: SetupStep["fallback"],
) {
  let broken = true;
  const run = vi.fn(async () => {
    if (broken)
      throw Object.assign(new Error(`${label} failed`), { retryable });
  });
  const step: SetupStep = { label, run, ...(fallback && { fallback }) };
  return { step, run, heal: () => (broken = false) };
}

it("retries from the failed step and rests where the steps would have", async () => {
  const setup = createSetup();
  const before = ok("Before");
  const failing = flaky("Linking", true);
  const after = ok("After");
  await setup.start([before, failing.step, after], {
    status: "paused",
    at: "key-reveal",
  });
  expect(setup.snapshot()).toEqual({
    status: "failed",
    error: "Linking failed",
    retryable: true,
  });

  failing.heal();
  await setup.retry();
  expect(setup.snapshot()).toEqual({ status: "paused", at: "key-reveal" });
  expect(before.run).toHaveBeenCalledTimes(1);
  expect(failing.run).toHaveBeenCalledTimes(2);
  expect(after.run).toHaveBeenCalledTimes(1);
});

it("reports only an error that says so as retryable, and names the fallback", async () => {
  const setup = createSetup();
  await setup.start([flaky("Backing up", false, { label: "Not now" }).step]);
  expect(setup.snapshot()).toEqual({
    status: "failed",
    error: "Backing up failed",
    retryable: false,
    fallback: "Not now",
  });
  await setup.start([
    { label: "Odd", run: () => Promise.reject<void>("text") },
  ]);
  expect(setup.snapshot()).toMatchObject({ retryable: false });
});

it("falls back by running the fallback, then resting at its page or carrying on", async () => {
  const declined = vi.fn(() => Promise.resolve());
  const rest = flaky("Backing up", false, { label: "Not now", run: declined });
  const after = ok("Finding communities…");
  const setup = createSetup();
  await setup.start([rest.step, after]);
  await setup.fallBack();
  expect(declined).toHaveBeenCalledTimes(1);
  expect(after.run).toHaveBeenCalledTimes(1);
  expect(setup.snapshot()).toEqual({ status: "done" });

  const shown = flaky("Linking", false, {
    label: "Show my key",
    rest: { status: "paused", at: "key-reveal" },
  });
  const skipped = ok("Backing up");
  const reveal = createSetup();
  await reveal.start([shown.step, skipped]);
  await reveal.fallBack();
  expect(skipped.run).not.toHaveBeenCalled();
  expect(reveal.snapshot()).toEqual({ status: "paused", at: "key-reveal" });
});

it("ignores Try again and the fallback unless failed, and a second click", async () => {
  let release!: () => void;
  const declined = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const failing = flaky("Backing up", true, {
    label: "Not now",
    run: declined,
  });
  const after = ok("After");
  const setup = createSetup();
  await setup.retry();
  await setup.fallBack();
  expect(setup.snapshot()).toEqual({ status: "idle" });

  await setup.start([failing.step, after]);
  const first = setup.fallBack();
  // The failed page stays up while the fallback runs; a second click does nothing.
  expect(setup.snapshot()).toMatchObject({ status: "failed" });
  await setup.fallBack();
  await setup.retry();
  expect(failing.run).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(declined).toHaveBeenCalledTimes(1);
  expect(after.run).toHaveBeenCalledTimes(1);
  expect(setup.snapshot()).toEqual({ status: "done" });

  // A step without a fallback keeps its failure for Try again.
  const bare = flaky("Linking", true);
  const again = createSetup();
  await again.start([bare.step]);
  await again.fallBack();
  bare.heal();
  await again.retry();
  expect(again.snapshot()).toEqual({ status: "done" });
});
