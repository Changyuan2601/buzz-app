import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// Main-thread priority lanes. Input runs first (React's discrete events),
// background store updates render as interruptible transitions, and idle work
// (persistence, prefetch) runs when the host has nothing more urgent.

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
export const backgroundBudgetMs = 100;

const overdue = new Set<() => void>();
let deadline: ReturnType<typeof setTimeout> | undefined;

function flushOverdue() {
  deadline = undefined;
  const updates = [...overdue];
  overdue.clear();
  // One task, so React commits every forced subscriber together.
  for (const update of updates) update();
}

/**
 * Renders `update` (a React state update) as a transition so input preempts
 * it, unless it is already handling input. If the transition has not
 * committed within the budget, it renders urgently with every other overdue
 * update. Call the returned function once the update has committed.
 */
export function scheduleBackgroundUpdate(update: () => void): () => void {
  if (handlingInput()) {
    update();
    return () => {};
  }
  startTransition(update);
  overdue.add(update);
  if (deadline === undefined)
    deadline = setTimeout(flushOverdue, backgroundBudgetMs);
  return () => {
    overdue.delete(update);
  };
}

/**
 * Like useSyncExternalStore, but changes published outside user input render
 * as a transition, so keystrokes preempt them for at most the budget. Changes
 * caused by input stay urgent.
 */
export function useBackgroundStore<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
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
      committed.current = scheduleBackgroundUpdate(update);
    };
    const unsubscribe = subscribe(listener);
    // Publishes between render and subscription.
    update();
    return () => {
      unsubscribe();
      committed.current?.();
      committed.current = undefined;
    };
  }, [subscribe, getSnapshot]);
  return value;
}

type IdleScheduler = {
  postTask?(
    callback: () => void,
    options: { priority: "background"; signal?: AbortSignal },
  ): Promise<void>;
};

/**
 * Runs `task` once the host is idle: scheduler.postTask background priority,
 * then requestIdleCallback, then a MessageChannel turn. Returns a cancel.
 */
export function scheduleIdle(task: () => void): () => void {
  const host = globalThis as typeof globalThis & {
    scheduler?: IdleScheduler;
  };
  if (host.scheduler?.postTask) {
    const controller = new AbortController();
    host.scheduler
      .postTask(task, { priority: "background", signal: controller.signal })
      .catch(() => {});
    return () => controller.abort();
  }
  if (typeof host.requestIdleCallback === "function") {
    const handle = host.requestIdleCallback(task, { timeout: 500 });
    return () => host.cancelIdleCallback(handle);
  }
  let cancelled = false;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    if (!cancelled) task();
  };
  channel.port2.postMessage(null);
  return () => {
    cancelled = true;
    channel.port1.close();
  };
}
