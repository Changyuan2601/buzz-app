// @vitest-environment node
import { expect, it } from "vitest";
import { processHost } from "./spawn";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("settles stopAll only once a process group that ignores SIGTERM is gone", async () => {
  const processes = processHost([
    { id: "sh", program: "/bin/sh", args: ["-c"] },
  ]);
  let out = "";
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  // The shell and the sleep it starts both ignore SIGTERM.
  const child = await processes.spawn("sh", {
    args: ["trap '' TERM; sleep 60 & echo $$ $!; wait"],
    onStdout: (data) => {
      out += data;
      if (out.includes("\n")) ready();
    },
  });
  await started;
  const pids = out.trim().split(" ").map(Number);
  expect(pids).toHaveLength(2);
  const before = Date.now();
  await processes.stopAll();
  // After the grace period's SIGKILL, not at once.
  expect(Date.now() - before).toBeGreaterThanOrEqual(2_900);
  for (const pid of pids) expect(alive(pid)).toBe(false);
  expect(await child.exited).toBeNull();
}, 10_000);

it("settles stopAll with nothing running", async () => {
  await expect(processHost([]).stopAll()).resolves.toBeUndefined();
});
