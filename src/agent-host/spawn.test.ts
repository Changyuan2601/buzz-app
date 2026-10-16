// @vitest-environment node
import { expect, it, vi } from "vitest";
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

it("kills what a process left running when it exits, stopped or not", async () => {
  const processes = processHost([
    { id: "sh", program: "/bin/sh", args: ["-c"] },
  ]);
  // A tool that ignores SIGTERM and lets go of the shell's pipes, so the
  // shell's exit closes them while it still runs.
  const tool =
    "(trap '' TERM; exec sleep 60 </dev/null >/dev/null 2>&1) & echo $!";
  const start = async (script: string) => {
    let out = "";
    let ready!: () => void;
    const printed = new Promise<void>((resolve) => (ready = resolve));
    const child = await processes.spawn("sh", {
      args: [script],
      onStdout: (data) => {
        out += data;
        if (out.includes("\n")) ready();
      },
    });
    await printed;
    return { child, pid: Number(out.trim()) };
  };
  // Stopped: the shell exits on SIGTERM at once, and stopAll waits for the
  // tool to be gone too, without the grace period.
  const stopped = await start(`${tool}; wait`);
  expect(alive(stopped.pid)).toBe(true);
  const before = Date.now();
  await processes.stopAll();
  expect(Date.now() - before).toBeLessThan(2_900);
  await vi.waitFor(() => expect(alive(stopped.pid)).toBe(false));
  // Not stopped: the shell ends by itself, and its tool goes with it.
  const ended = await start(tool);
  expect(await ended.child.exited).toBe(0);
  await vi.waitFor(() => expect(alive(ended.pid)).toBe(false));
  await processes.stopAll();
}, 10_000);

it("settles stopAll with nothing running", async () => {
  await expect(processHost([]).stopAll()).resolves.toBeUndefined();
});
