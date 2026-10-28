import { useCallback, useSyncExternalStore } from "react";
import { yieldToHost } from "./yield";

/** useSyncExternalStore that renders chosen changes in a later task. When
 * `later(previous, next)` holds for a published change, React hears of it in
 * the next host task instead of the publisher's microtasks, so a store commit
 * and the render it causes become two tasks rather than one long one. Any
 * other change renders as usual and takes a pending one with it. */
export function useScheduledSnapshot<T>(
  subscribe: (listener: () => void) => () => void,
  read: () => T,
  later: (previous: T, next: T) => boolean,
): T {
  const scheduled = useCallback(
    (listener: () => void) => {
      let previous = read();
      let pending: { cancelled: boolean } | undefined;
      const unsubscribe = subscribe(() => {
        const next = read();
        const defer = later(previous, next);
        previous = next;
        if (!defer) {
          if (pending) pending.cancelled = true;
          pending = undefined;
          return listener();
        }
        if (pending) return;
        const task = { cancelled: false };
        pending = task;
        void yieldToHost().then(() => {
          if (task.cancelled) return;
          pending = undefined;
          listener();
        });
      });
      return () => {
        if (pending) pending.cancelled = true;
        unsubscribe();
      };
    },
    [subscribe, read, later],
  );
  return useSyncExternalStore(scheduled, read, read);
}
