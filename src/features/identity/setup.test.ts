import { expect, it, vi } from "vitest";
import type { FirstRunAccount } from "./builderlab-account";
import { BackupError } from "./backup";
import { checkBackup, createSetup, type SetupStep } from "./setup";

const ok = (label: string): SetupStep => ({
  label,
  run: vi.fn(() => Promise.resolve()),
});
/** Fails until `heal`, with a retryable error when asked. */
function flaky(label: string, retryable: boolean) {
  let broken = true;
  const run = vi.fn(async () => {
    if (broken)
      throw Object.assign(new Error(`${label} failed`), { retryable });
  });
  const step: SetupStep = { label, run };
  return { step, run, heal: () => (broken = false) };
}

it("retries from the failed step and rests where the steps would have", async () => {
  const setup = createSetup();
  const before = ok("Before");
  const failing = flaky("Linking", true);
  const after = ok("After");
  await setup.start([before, failing.step, after], {
    status: "paused",
    at: "backup-offer",
  });
  expect(setup.snapshot()).toEqual({
    status: "failed",
    error: "Linking failed",
    retryable: true,
  });

  failing.heal();
  await setup.retry();
  expect(setup.snapshot()).toEqual({ status: "paused", at: "backup-offer" });
  expect(before.run).toHaveBeenCalledTimes(1);
  expect(failing.run).toHaveBeenCalledTimes(2);
  expect(after.run).toHaveBeenCalledTimes(1);
});

it("reports only an error that says so as retryable", async () => {
  const setup = createSetup();
  await setup.start([flaky("Backing up", false).step]);
  expect(setup.snapshot()).toEqual({
    status: "failed",
    error: "Backing up failed",
    retryable: false,
  });
  await setup.start([
    { label: "Odd", run: () => Promise.reject<void>("text") },
  ]);
  expect(setup.snapshot()).toMatchObject({ retryable: false });
});

it("ignores Try again unless failed, and a second click", async () => {
  const setup = createSetup();
  await setup.retry();
  expect(setup.snapshot()).toEqual({ status: "idle" });

  let release!: () => void;
  const run = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(
      Object.assign(new Error("Backing up failed"), { retryable: true }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
  const after = ok("After");
  await setup.start([{ label: "Backing up", run }, after]);
  const first = setup.retry();
  expect(setup.snapshot()).toEqual({ status: "running", label: "Backing up" });
  await setup.retry();
  release();
  await first;
  expect(run).toHaveBeenCalledTimes(2);
  expect(after.run).toHaveBeenCalledTimes(1);
  expect(setup.snapshot()).toEqual({ status: "done" });
});

it("reports the backed-up keys, and an unavailable or failed status as none listed without failing setup", async () => {
  const listed = "ab".repeat(32);
  const lookup = async (status: FirstRunAccount["backupStatus"]) => {
    const onListed = vi.fn();
    const setup = createSetup();
    await setup.start([
      checkBackup({ backupStatus: status } as FirstRunAccount, onListed),
    ]);
    expect(setup.snapshot()).toEqual({ status: "done" });
    return onListed.mock.calls;
  };
  expect(await lookup(() => Promise.resolve([listed]))).toEqual([[[listed]]]);
  expect(await lookup(() => Promise.resolve([]))).toEqual([[[]]]);
  expect(await lookup(() => Promise.resolve("unavailable"))).toEqual([
    [undefined],
  ]);
  expect(
    await lookup(() => Promise.reject(new BackupError("unreachable"))),
  ).toEqual([[undefined]]);
});
