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
// Growth by ten or more renders later; anything else renders at once.
const bigGrowth = (previous: number, next: number) => next - previous >= 10;
const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

it("renders a chosen change in a later task, not inside the publisher's", async () => {
  const source = store(1);
  const { result } = renderHook(() =>
    useScheduledSnapshot(source.subscribe, source.read, bigGrowth),
  );
  source.publish(20);
  // useSyncExternalStore alone would have rendered in the publisher's microtasks.
  await microtask();
  expect(result.current).toBe(1);
  await waitFor(() => expect(result.current).toBe(20));
});

it("renders other changes at once, taking a pending change with them", () => {
  const source = store(1);
  const { result } = renderHook(() =>
    useScheduledSnapshot(source.subscribe, source.read, bigGrowth),
  );
  act(() => source.publish(2));
  expect(result.current).toBe(2);
  act(() => {
    source.publish(30);
    source.publish(31);
  });
  expect(result.current).toBe(31);
});

it("reads a different store at once", () => {
  const first = store(1);
  const second = store(100);
  const { result, rerender } = renderHook(
    ({ source }) =>
      useScheduledSnapshot(source.subscribe, source.read, bigGrowth),
    { initialProps: { source: first } },
  );
  rerender({ source: second });
  expect(result.current).toBe(100);
});
