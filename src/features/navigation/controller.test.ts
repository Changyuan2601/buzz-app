import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavigationController, NAVIGATION_ABORTED } from "./controller";
import { createMemoryHistory, homeTarget } from "./history";
import type { OpenTarget } from "./targets";
const settings: OpenTarget = {
  version: 1,
  kind: "settings",
  section: "appearance",
};
const page: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "test",
  pageId: "board",
};
const cleanups: (() => void)[] = [];
function setup(capacity = 100) {
  const history = createMemoryHistory(homeTarget, capacity);
  const host = createNavigationController(history);
  cleanups.push(host.dispose);
  return { host, navigation: host.navigation, history };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("navigation attempts over one history driver", () => {
  it("pushes, traverses without a push, preserves forward on retry, and truncates new branches", async () => {
    const { host, navigation: nav } = setup();
    const initial = nav.snapshot().entry;
    const first = nav.open(settings);
    const settingsEntry = nav.snapshot().entry;
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(first).resolves.toEqual({ status: "opened" });
    void nav.open(page);
    nav.back();
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    const retry = nav.retry();
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    const same = nav.open(settings);
    await expect(retry).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot().entry).toBe(settingsEntry);
    expect(nav.snapshot().canGoForward).toBe(true);
    nav.forward();
    await expect(same).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot().entry.target).toEqual(page);
    nav.back();
    nav.back();
    expect(nav.snapshot().entry).toBe(initial);
    void nav.open({ version: 1, kind: "settings", section: "plugins" });
    expect(nav.snapshot().canGoForward).toBe(false);
  });
  it("dismisses a modal visit back to its opener, or replaces it, without adding a visit", () => {
    const { navigation: nav } = setup();
    void nav.open(page);
    const opener = nav.snapshot().entry;
    void nav.open(settings);
    void nav.open(page, { dismiss: true });
    expect(nav.snapshot().entry).toBe(opener);
    expect(nav.snapshot().canGoForward).toBe(true);
    nav.forward();
    const other: OpenTarget = { ...page, pageId: "other" };
    void nav.open(other, { dismiss: true });
    expect(nav.snapshot().entry.target).toEqual(other);
    expect(nav.snapshot().canGoForward).toBe(false);
    nav.back();
    expect(nav.snapshot().entry).toBe(opener);
  });
  it("rejects late acknowledgments and aborts obsolete work even after successful reveal", async () => {
    const { host, navigation: nav } = setup();
    const first = nav.open(settings),
      old = nav.snapshot().attempt;
    const second = nav.open(page),
      current = nav.snapshot().attempt;
    expect(old.signal.aborted).toBe(true);
    expect(host.complete(old, { status: "opened" })).toBe(false);
    expect(nav.snapshot().status).toBe("opening");
    expect(host.complete({ ...current }, { status: "opened" })).toBe(false);
    expect(host.complete(current, { status: "opened" })).toBe(true);
    expect(host.complete(current, { status: "opened" })).toBe(false);
    await expect(first).resolves.toEqual({ status: "superseded" });
    await expect(second).resolves.toEqual({ status: "opened" });
    void nav.retry();
    expect(current.signal.aborted).toBe(true);
    // One shared reason: a fresh DOMException per abort would carry a stack
    // that pins the next attempt and the opening click's target DOM.
    expect(old.signal.reason).toBeInstanceOf(DOMException);
    expect(old.signal.reason.name).toBe("AbortError");
    expect(current.signal.reason).toBe(old.signal.reason);
    expect(nav.snapshot().attempt.id).not.toBe(current.id);
  });
  it("reports truthful failure, timeout and cancellation and keeps the original target retryable", async () => {
    vi.useFakeTimers();
    const { host, navigation: nav } = setup();
    const first = nav.open(settings);
    host.complete(nav.snapshot().attempt, {
      status: "failed",
      reason: "unavailable",
    });
    await expect(first).resolves.toEqual({
      status: "failed",
      reason: "unavailable",
    });
    expect(nav.snapshot().entry.target).toEqual(settings);
    expect(nav.snapshot().attempt.signal.aborted).toBe(true);
    expect(nav.snapshot().attempt.signal.reason).toBe(NAVIGATION_ABORTED);
    const retry = nav.retry();
    expect(nav.snapshot().reason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(retry).resolves.toEqual({
      status: "failed",
      reason: "timeout",
    });
    const cancelled = nav.retry();
    const attempt = nav.snapshot().attempt;
    host.cancel();
    expect(attempt.signal.reason).toBe(NAVIGATION_ABORTED);
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
  it("rejects invalid targets before cancelling or moving the current intent", async () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const before = nav.snapshot();
    await expect(
      nav.open({ version: 42 } as unknown as OpenTarget),
    ).resolves.toEqual({ status: "failed", reason: "invalid-target" });
    expect(nav.snapshot()).toBe(before);
    expect(before.attempt.signal.aborted).toBe(false);
  });
  it("records a host ingress failure against the current visit without moving or inventing one", async () => {
    const { host, navigation: nav } = setup();
    const opened = nav.open(settings);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(opened).resolves.toEqual({ status: "opened" });
    const entry = nav.snapshot().entry;
    const listener = vi.fn();
    nav.subscribe(listener);
    host.fail("invalid-target");
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "invalid-target",
      entry,
      canGoBack: true,
    });
    expect(nav.snapshot().attempt.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalled();
    // An invalid incoming URL cannot accidentally retry the previous visit.
    await expect(nav.retry()).resolves.toEqual({
      status: "failed",
      reason: "invalid-target",
    });
    expect(nav.snapshot().status).toBe("failed");
    expect(nav.snapshot().retryable).toBe(false);
    expect(nav.snapshot().entry).toBe(entry);
    // A failure while another open is pending supersedes it like any new intent.
    const pending = nav.open(page);
    host.fail("unavailable");
    await expect(pending).resolves.toEqual({ status: "superseded" });
    expect(nav.snapshot()).toMatchObject({
      status: "failed",
      reason: "unavailable",
    });
    expect(nav.snapshot().entry.target).toEqual(page);
    const settled = nav.snapshot();
    host.dispose();
    host.fail("unavailable");
    expect(nav.snapshot()).toBe(settled);
  });
  it("keeps separate visit identities for the same destination; replace doesn't push", () => {
    const { navigation: nav } = setup();
    void nav.open(settings);
    const first = nav.snapshot().entry;
    void nav.open(page);
    void nav.open(settings);
    expect(nav.snapshot().entry.id).not.toBe(first.id);
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(page);
    void nav.open(homeTarget, { replace: true });
    nav.back();
    expect(nav.snapshot().entry).toBe(first);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(homeTarget);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(settings);
  });
  it("uses driver-initiated traversal and bounds the memory driver without inventing history", () => {
    const { navigation: nav, history } = setup(2);
    void nav.open(settings);
    void nav.open(page);
    history.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    expect(nav.snapshot().canGoBack).toBe(false);
    history.back();
    expect(nav.snapshot().entry.target).toEqual(settings);
    history.forward();
    expect(nav.snapshot().entry.target).toEqual(page);
  });
  it("disposes owned work and listeners and cannot reopen afterward", async () => {
    const { host, navigation: nav } = setup();
    const pending = nav.open(page),
      attempt = nav.snapshot().attempt;
    host.dispose();
    expect(attempt.signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    const listener = vi.fn();
    nav.subscribe(listener);
    await expect(nav.open(settings)).resolves.toEqual({ status: "cancelled" });
    nav.back();
    nav.forward();
    expect(listener).not.toHaveBeenCalled();
    expect(host.complete(attempt, { status: "opened" })).toBe(false);
  });
});

it("default resolution preserves visit, promise, signal and deadline while revoking the old completion token", async () => {
  vi.useFakeTimers();
  const { host, navigation: nav } = setup();
  const pending = nav.open(page);
  const old = nav.snapshot().attempt;
  await vi.advanceTimersByTimeAsync(14_000);
  expect(host.resolve(old, settings)).toBe(true);
  const current = nav.snapshot().attempt;
  expect(current.entry.id).toBe(old.entry.id);
  expect(current.signal).toBe(old.signal);
  expect(old.signal.aborted).toBe(false);
  expect(current.entry.target).toEqual(settings);
  expect(host.complete(old, { status: "opened" })).toBe(false);
  expect(host.resolve(old, page)).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(pending).resolves.toEqual({
    status: "failed",
    reason: "timeout",
  });
  expect(host.resolve(current, page)).toBe(false);
});

it("resolved presentation settles the original caller and cannot outlive new intent or cancellation", async () => {
  const { host, navigation: nav } = setup();
  const first = nav.open(page);
  host.resolve(nav.snapshot().attempt, settings);
  host.complete(nav.snapshot().attempt, { status: "opened" });
  await expect(first).resolves.toEqual({ status: "opened" });
  const second = nav.open(page);
  host.resolve(nav.snapshot().attempt, settings);
  const retired = nav.snapshot().attempt;
  const next = nav.open(homeTarget);
  await expect(second).resolves.toEqual({ status: "superseded" });
  expect(retired.signal.aborted).toBe(true);
  expect(host.resolve(retired, page)).toBe(false);
  expect(host.complete(retired, { status: "opened" })).toBe(false);
  const cancelled = nav.snapshot().attempt;
  host.cancel();
  await expect(next).resolves.toEqual({ status: "cancelled" });
  expect(host.resolve(cancelled, page)).toBe(false);
});

it("resolution observers may introduce real competing intent without capturing the original promise", async () => {
  const { host, navigation: nav } = setup();
  const first = nav.open(page);
  let next: ReturnType<typeof nav.open> | undefined;
  const off = nav.subscribe(() => {
    if (nav.snapshot().entry.target.kind === "settings")
      next = nav.open(homeTarget);
  });
  host.resolve(nav.snapshot().attempt, settings);
  expect(nav.snapshot().entry.target).toEqual(homeTarget);
  host.complete(nav.snapshot().attempt, { status: "opened" });
  await expect(first).resolves.toEqual({ status: "superseded" });
  await expect(next).resolves.toEqual({ status: "opened" });
  off();
});
