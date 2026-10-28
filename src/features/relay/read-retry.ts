import {
  isTransientFailure,
  readErrorKind,
  ReadError,
  ReadRetriesExhausted,
} from "./errors.ts";
import { RECOVERY_DELAYS_MS } from "./recovery.ts";

export function isRetryableRead(error: unknown): boolean {
  if (readErrorKind(error) === "cancelled") return false;
  if (error instanceof Error && error.cause !== undefined)
    return isRetryableRead(error.cause);
  return isTransientFailure(error);
}

function exhausted(error: unknown): boolean {
  return (
    error instanceof ReadRetriesExhausted ||
    (error instanceof Error &&
      error.cause !== undefined &&
      exhausted(error.cause))
  );
}

/** One initial read and three quiet retries. Nested owners share exhaustion,
 * rather than multiplying budgets. The caller owns the read's lifetime. */
export async function retryRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  retryable: (error: unknown) => boolean = isRetryableRead,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const value = await read(signal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      if (exhausted(error) || !retryable(error)) throw error;
      if (attempt === 3) throw new ReadRetriesExhausted(error);
      const ceiling = RECOVERY_DELAYS_MS[attempt] ?? 4000;
      // Admission has its own actionable cooldown. Never hide it behind a
      // pending read longer than this retry's normal backoff ceiling.
      if (error instanceof ReadError && (error.retryAfterMs ?? 0) > ceiling)
        throw new ReadRetriesExhausted(error);
      const delay = Math.max(
        ceiling * (0.5 + Math.random() / 2),
        error instanceof ReadError ? (error.retryAfterMs ?? 0) : 0,
      );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, delay);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
