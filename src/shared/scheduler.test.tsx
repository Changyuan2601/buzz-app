// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  backgroundBudgetMs,
  scheduleIdle,
  useBackgroundStore,
} from "./scheduler";

function store(initial: number) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: number) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function Value({ source }: { source: ReturnType<typeof store> }) {
  const value = useBackgroundStore(source.subscribe, source.get);
  return <output>{value}</output>;
}

afterEach(cleanup);

it("renders a background publish and settles on the latest snapshot", async () => {
  const source = store(1);
  render(<Value source={source} />);
  expect(screen.getByRole("status").textContent).toBe("1");
  await act(async () => {
    source.set(2);
    source.set(3);
  });
  expect(screen.getByRole("status").textContent).toBe("3");
});

it("renders a publish caused by input urgently", () => {
  const source = store(1);
  render(
    <>
      <button type="button" onClick={() => source.set(5)}>
        set
      </button>
      <Value source={source} />
    </>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("status").textContent).toBe("5");
});

it("reads a new source synchronously instead of the previous snapshot", () => {
  const first = store(1);
  const second = store(2);
  const { rerender } = render(<Value source={first} />);
  rerender(<Value source={second} />);
  expect(screen.getByRole("status").textContent).toBe("2");
});

it("catches a publish between render and subscription", async () => {
  const source = store(1);
  function Publishing() {
    const value = useBackgroundStore(source.subscribe, source.get);
    if (value === 1) queueMicrotask(() => source.set(7));
    return <output>{value}</output>;
  }
  render(<Publishing />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("7");
});

it("renders an overdue background update within the budget", async () => {
  const source = store(1);
  render(<Value source={source} />);
  await act(async () => {
    source.set(2);
    await new Promise((resolve) => setTimeout(resolve, backgroundBudgetMs * 2));
  });
  expect(screen.getByRole("status").textContent).toBe("2");
});

it("runs idle work later and honours cancellation", async () => {
  const ran: string[] = [];
  scheduleIdle(() => ran.push("kept"));
  const cancel = scheduleIdle(() => ran.push("cancelled"));
  cancel();
  expect(ran).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(ran).toEqual(["kept"]);
});

it("renders a change the background predicate rejects without the transition", async () => {
  const source = store(1);
  function Urgent() {
    const value = useBackgroundStore(
      source.subscribe,
      source.get,
      (current, next) => next > current,
    );
    return <output>{value}</output>;
  }
  render(<Urgent />);
  await act(async () => source.set(0));
  expect(screen.getByRole("status").textContent).toBe("0");
  await act(async () => source.set(4));
  expect(screen.getByRole("status").textContent).toBe("4");
});
