import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTransientFailure, ReadError, ReadRetriesExhausted } from "./errors";
import { retryRead } from "./read-retry";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retries transient reads at the backoff boundaries and returns success", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue("loaded");
  const pending = retryRead(read, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(749);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe("loaded");
  expect(read).toHaveBeenCalledTimes(2);
});

it("exhausts once across nested owners and preserves the original failure", async () => {
  const error = new ReadError("unavailable", "offline", 503);
  const read = vi.fn().mockRejectedValue(error);
  const signal = new AbortController().signal;
  const pending = retryRead(() => retryRead(read, signal), signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "ReadRetriesExhausted",
    message: "offline",
    cause: error,
  });
  for (const [index, delay] of [750, 1500, 3000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(read).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
  }
  await rejected;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(4);
  expect(isTransientFailure(new ReadRetriesExhausted(error))).toBe(true);
  expect(String(new ReadRetriesExhausted(error))).toBe(String(error));
  expect(
    isTransientFailure(
      new Error("context", { cause: new ReadRetriesExhausted(error) }),
    ),
  ).toBe(true);
});

it.each([
  new ReadError("denied", "denied", 403),
  new ReadError("invalid-response", "invalid"),
  new Error("Invalid input"),
])("surfaces permanent failures immediately: %s", async (error) => {
  const read = vi.fn().mockRejectedValue(error);
  await expect(retryRead(read, new AbortController().signal)).rejects.toBe(
    error,
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledOnce();
});

it.each([5000, 60000, 86401000])(
  "surfaces long admission delays immediately: %s",
  async (delay) => {
    const error = new ReadError("unavailable", "quota", 429, delay);
    const read = vi.fn().mockRejectedValue(error);
    await expect(
      retryRead(read, new AbortController().signal),
    ).rejects.toMatchObject({ cause: error });
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("honors admission hints within the bounded backoff", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new ReadError("unavailable", "quota", 429, 900))
    .mockResolvedValue([]);
  const pending = retryRead(read, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(899);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([
  new DOMException("retired", "AbortError"),
  new ReadError("cancelled", "cancelled"),
  new Error("context", { cause: new DOMException("retired", "AbortError") }),
])("does not retry owner cancellations: %s", async (error) => {
  const read = vi.fn().mockRejectedValue(error);
  await expect(retryRead(read, new AbortController().signal)).rejects.toBe(
    error,
  );
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves nested exhaustion through context wrappers", async () => {
  const signal = new AbortController().signal;
  const read = vi.fn().mockRejectedValue(new TypeError("offline"));
  const pending = retryRead(async () => {
    try {
      return await retryRead(read, signal);
    } catch (cause) {
      throw new Error("context", { cause });
    }
  }, signal);
  const rejected = expect(pending).rejects.toMatchObject({
    message: "context",
  });
  await vi.advanceTimersByTimeAsync(5250);
  await rejected;
  expect(read).toHaveBeenCalledTimes(4);
});

it("aborts backoff and releases the timer", async () => {
  const controller = new AbortController();
  const read = vi.fn().mockRejectedValue(new TypeError("offline"));
  const pending = retryRead(read, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects late success from a read that ignores cancellation", async () => {
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const pending = retryRead(read, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  resolve("obsolete");
  await rejected;
  expect(read).toHaveBeenCalledOnce();
});
