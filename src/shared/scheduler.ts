import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// Main-thread priority lanes. Input runs first (React's discrete events), and
// background store updates render as interruptible transitions with a deadline.

const discrete = new Set([
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionend",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "touchstart",
  "touchend",
  "paste",
  "cut",
  "drop",
  "focusin",
  "focusout",
  "submit",
]);

/** True while the host is dispatching a user input event. */
export function handlingInput(): boolean {
  if (typeof window === "undefined") return false;
  const event = window.event;
  return !!event && discrete.has(event.type);
}

/** Longest a background update may wait behind input before it renders anyway. */
export const backgroundBudgetMs = 50;

const overdue = new Set<() => void>();
let deadline: ReturnType<typeof setTimeout> | undefined;
let since = 0;
// A saturated main thread runs the deadline timer late, so input that arrives
// after the budget renders overdue updates with itself.
const inputs = ["keydown", "pointerdown"] as const;

function flushOverdue() {
  settle();
  const updates = [...overdue];
  overdue.clear();
  // One task, so React commits every forced subscriber together.
  for (const update of updates) update();
}

function flushOnInput() {
  if (performance.now() - since >= backgroundBudgetMs) flushOverdue();
}

function settle() {
  clearTimeout(deadline);
  deadline = undefined;
  for (const type of inputs)
    window.removeEventListener(type, flushOnInput, true);
}

/**
 * Renders `update` (a React state update) as a transition so input preempts
 * it, unless it is already handling input. If the transition has not
 * committed within the budget, it renders urgently with every other overdue
 * update, at the deadline or with the next input, whichever runs first. Call
 * the returned function once the update has committed.
 */
export function scheduleBackgroundUpdate(update: () => void): () => void {
  if (handlingInput()) {
    update();
    return () => {};
  }
  startTransition(update);
  overdue.add(update);
  if (deadline === undefined) {
    since = performance.now();
    deadline = setTimeout(flushOverdue, backgroundBudgetMs);
    for (const type of inputs)
      window.addEventListener(type, flushOnInput, true);
  }
  return () => {
    overdue.delete(update);
    if (!overdue.size) settle();
  };
}

const always = () => true;

/**
 * Like useSyncExternalStore, but changes published outside user input render
 * as a transition, so keystrokes preempt them for at most the budget. Changes
 * caused by input, and changes `background` rejects (a requested page, a
 * status change), stay urgent.
 */
export function useBackgroundStore<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  background: (current: T, next: T) => boolean = always,
): T {
  const [state, setState] = useState(() => ({
    getSnapshot,
    value: getSnapshot(),
  }));
  let { value } = state;
  // A new source (another channel or thread) is read synchronously, never
  // through a stale snapshot of the previous one.
  if (state.getSnapshot !== getSnapshot) {
    value = getSnapshot();
    setState({ getSnapshot, value });
  }
  const committed = useRef<() => void>(undefined);
  // The newest snapshot this hook has rendered or scheduled.
  const latest = useRef(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs when a new value commits.
  useLayoutEffect(() => {
    committed.current?.();
    committed.current = undefined;
  }, [value]);
  useEffect(() => {
    const update = () =>
      setState((current) => {
        const next = getSnapshot();
        return current.getSnapshot === getSnapshot &&
          Object.is(current.value, next)
          ? current
          : { getSnapshot, value: next };
      });
    const listener = () => {
      committed.current?.();
      committed.current = undefined;
      const next = getSnapshot();
      if (background(latest.current, next))
        committed.current = scheduleBackgroundUpdate(update);
      else update();
      latest.current = next;
    };
    latest.current = getSnapshot();
    const unsubscribe = subscribe(listener);
    // Publishes between render and subscription.
    update();
    return () => {
      unsubscribe();
      committed.current?.();
      committed.current = undefined;
    };
  }, [subscribe, getSnapshot, background]);
  return value;
}
