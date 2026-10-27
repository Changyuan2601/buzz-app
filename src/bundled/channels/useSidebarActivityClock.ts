import { useSyncExternalStore } from "react";

const TICK_MS = 60_000;
const listeners = new Set<() => void>();
let nowSeconds = Date.now() / 1000;
let timer: number | undefined;

function tick() {
  nowSeconds = Date.now() / 1000;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const next = Date.now() / 1000;
    if (next !== nowSeconds) {
      nowSeconds = next;
      listener();
    }
    timer = window.setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot() {
  return nowSeconds;
}

export function useSidebarActivityNow() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
