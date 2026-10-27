import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "./browser";
import { createOAuthSession, SESSION_EXPIRED } from "./session";
import { deferred } from "../test-helpers";

const credential: Credential = {
  value: "private-token",
  expiresAt: Date.now() + 86_400_000,
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
  },
};
it("keeps credentials outside UI snapshots and clears them on sign-out and disposal", async () => {
  const acquire = vi.fn(async () => credential);
  const session = createOAuthSession(acquire);
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
  session.signOut();
  expect(() => session.credential()).toThrow("Sign in");
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  unsubscribe();
  await session.signIn();
  session.dispose();
  expect(listener).not.toHaveBeenCalled();
  expect(() => session.credential()).toThrow("Sign in");
  await session.signIn();
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("session is closed");
  expect(acquire).toHaveBeenCalledTimes(2);
});
it.each(["cancel", "signOut", "dispose"] as const)(
  "%s settles a creation wait and rejects late credentials",
  async (action) => {
    const release = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const session = createOAuthSession(async (current) => {
      signal = current;
      return release.promise;
    });
    const pending = session.signIn();
    const rejected = expect(
      session.ensureSignedIn(new AbortController().signal),
    ).rejects.toThrow("Sign-in canceled.");
    try {
      expect(session.snapshot().status).toBe("pending");
      session[action]();
      expect(signal?.aborted).toBe(true);
      await rejected;
    } finally {
      release.resolve(credential);
      await pending;
    }
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    expect(() => session.credential()).toThrow("Sign in");
  },
);
it("a stale failure cannot replace a new sign-in", async () => {
  const old = deferred<Credential>();
  const acquire = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  const pending = session.signIn();
  session.cancel();
  await session.signIn();
  old.reject(new Error("stale failure"));
  await pending;
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
});
it("creation joins an existing Settings login and aborts its wait without canceling the shared attempt", async () => {
  const release = deferred<Credential>();
  const acquire = vi.fn(() => release.promise);
  const session = createOAuthSession(acquire);
  const settings = session.signIn();
  const canceled = new AbortController();
  const aborted = expect(
    session.ensureSignedIn(canceled.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const waiting = session.ensureSignedIn(new AbortController().signal);
  try {
    canceled.abort();
    await aborted;
    expect(session.snapshot().status).toBe("pending");
    expect(acquire).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(credential);
    await settings;
    await waiting;
  }
  expect(session.credential()).toBe(credential);
  await session.ensureSignedIn(new AbortController().signal);
  expect(acquire).toHaveBeenCalledTimes(1);
});

describe("expiry", () => {
  const HOUR = 3_600_000;
  const MAX_DELAY = 2_147_483_647;
  const expiredState = { status: "signed-out", error: SESSION_EXPIRED };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const fresh = (lifetime = 2 * HOUR): Credential => ({
    ...credential,
    expiresAt: Date.now() + lifetime,
  });
  it("signs out with a visible error a minute before the server's expiry, and sign-out disarms it", async () => {
    const session = createOAuthSession(async () => fresh());
    const listener = vi.fn();
    session.subscribe(listener);
    await session.signIn();
    listener.mockClear();
    vi.advanceTimersByTime(2 * HOUR - 60_000 - 1);
    expect(session.snapshot().status).toBe("signed-in");
    vi.advanceTimersByTime(1);
    expect(session.snapshot()).toEqual(expiredState);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => session.credential()).toThrow("Sign in");
    await session.signIn();
    session.signOut();
    listener.mockClear();
    vi.advanceTimersByTime(3 * HOUR);
    expect(listener).not.toHaveBeenCalled();
    expect(session.snapshot()).toEqual({ status: "signed-out" });
  });
  it("a new sign-in replaces the earlier credential's timer", async () => {
    const session = createOAuthSession(async () => fresh());
    await session.signIn();
    vi.advanceTimersByTime(HOUR);
    await session.signIn();
    vi.advanceTimersByTime(HOUR);
    expect(session.snapshot().status).toBe("signed-in");
    vi.advanceTimersByTime(HOUR - 60_000);
    expect(session.snapshot()).toEqual(expiredState);
  });
  it("re-arms across setTimeout's longest delay", async () => {
    const lifetime = 30 * 24 * HOUR;
    const session = createOAuthSession(async () => fresh(lifetime));
    await session.signIn();
    vi.advanceTimersByTime(MAX_DELAY);
    expect(session.snapshot().status).toBe("signed-in");
    vi.advanceTimersByTime(lifetime - 60_000 - MAX_DELAY);
    expect(session.snapshot()).toEqual(expiredState);
  });
  it("credential() and ensureSignedIn treat a credential the clock has outrun as signed out", async () => {
    const acquire = vi.fn(async () => fresh());
    const session = createOAuthSession(acquire);
    const listener = vi.fn();
    session.subscribe(listener);
    await session.signIn();
    listener.mockClear();
    // The clock moves while the timer does not, as after sleep.
    vi.setSystemTime(Date.now() + 2 * HOUR - 60_000);
    expect(() => session.credential()).toThrow("Sign in");
    expect(session.snapshot()).toEqual(expiredState);
    expect(listener).toHaveBeenCalledTimes(1);
    await session.signIn();
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await session.ensureSignedIn(new AbortController().signal);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(session.snapshot().status).toBe("signed-in");
    expect(session.credential().expiresAt).toBe(Date.now() + 2 * HOUR);
  });
  it("reports one expiry for concurrent 401s", async () => {
    const session = createOAuthSession(async () => fresh());
    await session.signIn();
    const listener = vi.fn();
    session.subscribe(listener);
    session.expire();
    session.expire();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toEqual(expiredState);
  });
});
