import { expect, it, vi } from "vitest";
import { createDraftGuard } from "../drafts/guard";
import { createNavigationController } from "./controller";
import { createMemoryHistory } from "./history";

const first = { version: 1, kind: "settings", section: "appearance" } as const;
const second = { version: 1, kind: "settings", section: "agents" } as const;

it("asks before changing history, and Cancel retains the exact presentation", async () => {
  const guard = createDraftGuard();
  const host = createNavigationController(createMemoryHistory(), 15_000, guard);
  const reset = vi.fn();
  const editor = guard.register({}, "agent settings", reset);
  try {
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    const previous = host.navigation.snapshot();
    editor.update({ dirty: true, saving: false });
    const leave = host.navigation.open(first);
    expect(host.navigation.snapshot()).toBe(previous);
    expect(previous.attempt.signal.aborted).toBe(false);
    guard.cancel();
    expect(await leave).toEqual({ status: "cancelled" });
    expect(reset).not.toHaveBeenCalled();
    expect(host.navigation.snapshot()).toBe(previous);
    const approved = host.navigation.open(first);
    guard.discard();
    await vi.waitFor(() =>
      expect(host.navigation.snapshot().entry.target).toEqual(first),
    );
    expect(previous.attempt.signal.aborted).toBe(true);
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    expect(await approved).toEqual({ status: "opened" });
  } finally {
    host.dispose();
    guard.dispose();
  }
});

it.each(["back", "forward"] as const)(
  "guards app %s without losing the forward branch",
  async (direction) => {
    const guard = createDraftGuard();
    const host = createNavigationController(
      createMemoryHistory(),
      15_000,
      guard,
    );
    try {
      void host.navigation.open(first);
      void host.navigation.open(second);
      if (direction === "forward") host.navigation.back();
      const before = host.navigation.snapshot();
      guard
        .register({}, "agent settings", () => {})
        .update({ dirty: true, saving: false });
      host.navigation[direction]();
      expect(host.navigation.snapshot()).toBe(before);
      guard.cancel();
      expect(host.navigation.snapshot()).toBe(before);
      host.navigation[direction]();
      guard.discard();
      await vi.waitFor(() =>
        expect(host.navigation.snapshot().entry.target).toEqual(
          direction === "back" ? first : second,
        ),
      );
      if (direction === "back")
        expect(host.navigation.snapshot().canGoForward).toBe(true);
    } finally {
      host.dispose();
      guard.dispose();
    }
  },
);

it("does not replay an approved departure after disposal", async () => {
  const guard = createDraftGuard();
  const history = createMemoryHistory();
  const host = createNavigationController(history, 15_000, guard);
  guard
    .register({}, "agent settings", () => {})
    .update({ dirty: true, saving: false });
  const before = history.snapshot();
  const leave = host.navigation.open(first);
  host.dispose();
  guard.discard();
  expect(await leave).toEqual({ status: "cancelled" });
  expect(history.snapshot()).toBe(before);
  guard.dispose();
});
