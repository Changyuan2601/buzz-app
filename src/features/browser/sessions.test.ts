import { expect, it, vi } from "vitest";
import type { BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function platform(): BrowserPlatform {
  return {
    available: true,
    attach: vi.fn(),
    setBounds: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(async () => {}),
  };
}

const bounds = { x: 0, y: 0, width: 100, height: 100 };

it("does not attach a queued view that was disposed while waiting", async () => {
  const first = deferred<string>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockImplementation(() => first.promise);
  const sessions = new BrowserSessions(browserPlatform);
  const active = sessions.attach("https://one.example", bounds, () => true);
  let queuedCurrent = true;
  const queued = sessions.attach(
    "https://two.example",
    bounds,
    () => queuedCurrent,
  );
  queuedCurrent = false;
  first.resolve("session-1");
  await expect(active).resolves.toBe("session-1");
  await expect(queued).resolves.toBeUndefined();
  expect(browserPlatform.attach).toHaveBeenCalledTimes(1);
});

it("detaches an attach result whose view was disposed in flight", async () => {
  const attached = deferred<string>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockImplementation(() => attached.promise);
  const sessions = new BrowserSessions(browserPlatform);
  let current = true;
  const result = sessions.attach("https://example.com", bounds, () => current);
  await vi.waitFor(() =>
    expect(browserPlatform.attach).toHaveBeenCalledTimes(1),
  );
  current = false;
  attached.resolve("session-1");
  await expect(result).resolves.toBeUndefined();
  expect(browserPlatform.detach).toHaveBeenCalledWith("session-1");
});

it("closes a parked guest after it waits too long", async () => {
  vi.useFakeTimers();
  try {
    const browserPlatform = platform();
    vi.mocked(browserPlatform.attach).mockResolvedValue("session-1");
    const sessions = new BrowserSessions(browserPlatform);
    await sessions.attach("https://a.example", bounds, () => true, "s", "k");
    await sessions.detach("session-1", "k");
    expect(browserPlatform.detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(browserPlatform.detach).toHaveBeenCalledWith("session-1");
    expect(sessions.owns("session-1")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("makes room by closing parked guests before hidden ones", async () => {
  const browserPlatform = platform();
  let next = 0;
  vi.mocked(browserPlatform.attach).mockImplementation(
    async () => `session-${++next}`,
  );
  const sessions = new BrowserSessions(browserPlatform);
  for (const key of ["a", "b", "c", "d"])
    await sessions.attach(
      `https://${key}.example`,
      bounds,
      () => true,
      "s",
      key,
    );
  for (const id of ["session-1", "session-2", "session-4"])
    sessions.present(id, true);
  sessions.present("session-1", false);
  await sessions.detach("session-3", "c");
  await sessions.attach("https://e.example", bounds, () => true);
  expect(browserPlatform.detach).toHaveBeenCalledWith("session-3");
  await sessions.attach("https://f.example", bounds, () => true);
  expect(browserPlatform.detach).toHaveBeenLastCalledWith("session-1");
  expect(sessions.owns("session-2")).toBe(true);
});

it("a parked guest is adopted only under its key", async () => {
  const browserPlatform = platform();
  let next = 0;
  vi.mocked(browserPlatform.attach).mockImplementation(
    async () => `session-${++next}`,
  );
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  await sessions.detach("session-1", "a");
  await expect(
    sessions.attach("https://b.example", bounds, () => true, "s", "b"),
  ).resolves.toBe("session-2");
  await expect(
    sessions.attach("https://a.example", bounds, () => true, "s", "a"),
  ).resolves.toBe("session-1");
});
