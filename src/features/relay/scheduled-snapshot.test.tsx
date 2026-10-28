// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useScheduledSnapshot } from "./scheduled-snapshot";

afterEach(cleanup);

function store(initial: number) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: number) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

it("renders a publish in a later task, not inside the publisher's", async () => {
  const source = store(1);
  const { result } = renderHook(() =>
    useScheduledSnapshot(source.subscribe, source.read),
  );
  expect(result.current).toBe(1);
  source.publish(2);
  // useSyncExternalStore would have rendered in the publisher's microtasks.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(result.current).toBe(1);
  await waitFor(() => expect(result.current).toBe(2));
});

it("reads a different store at once and catches a change missed before subscribing", () => {
  const first = store(1);
  const second = store(10);
  const { result, rerender } = renderHook(
    ({ source }) => useScheduledSnapshot(source.subscribe, source.read),
    { initialProps: { source: first } },
  );
  rerender({ source: second });
  expect(result.current).toBe(10);
  act(() => second.publish(11));
  expect(result.current).toBe(11);
});
