import { parseOpenTarget, targetKey, type OpenTarget } from "./targets";

/** Stable visit identity, distinct from the cancellable attempts to reveal it. */
export type NavigationEntry = Readonly<{ id: string; target: OpenTarget }>;
export type HistorySnapshot = Readonly<{
  current: NavigationEntry;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Host-address parsing failed; retained target is not a successful destination. */
  invalidAddress?: boolean;
}>;
/** A host uses exactly one driver. Traversal publishes; it never calls push. */
export interface NavigationHistory {
  snapshot(): HistorySnapshot;
  /** Exactly one controller attachment for the lifetime of this driver. UI observes Navigation. */
  attach(controller: () => void): () => void;
  push(target: OpenTarget): void;
  /** Normalize this visit's resolved destination without creating another visit. */
  resolve(target: OpenTarget): void;
  replace(target: OpenTarget): void;
  back(): void;
  forward(): void;
  dispose(): void;
}
export const homeTarget = Object.freeze({ version: 1, kind: "home" } as const);
export function navigationEntry(target: OpenTarget): NavigationEntry {
  return Object.freeze({
    id: crypto.randomUUID(),
    target: parseOpenTarget(target),
  });
}

/** Non-browser host driver. Browser hosts supply actual session-history traversal. */
export function createMemoryHistory(
  initial: OpenTarget = homeTarget,
  capacity = 100,
): NavigationHistory {
  if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 1000)
    throw new Error("Invalid navigation history capacity");
  let entries = [navigationEntry(initial)];
  let index = 0;
  let disposed = false;
  let attached = false;
  let controller: (() => void) | undefined;
  const current = () =>
    Object.freeze({
      current: entries[index] as NavigationEntry,
      canGoBack: index > 0,
      canGoForward: index < entries.length - 1,
    });
  let snapshot = current();
  function emit() {
    snapshot = current();
    controller?.();
  }
  return {
    snapshot: () => snapshot,
    attach(listener) {
      if (attached || disposed)
        throw new Error("Navigation history already has an owner");
      attached = true;
      controller = listener;
      return () => {
        controller = undefined;
      };
    },
    push(input) {
      if (disposed) return;
      const target = parseOpenTarget(input);
      if (targetKey(target) === targetKey(snapshot.current.target)) return;
      entries = [...entries.slice(0, index + 1), navigationEntry(target)].slice(
        -capacity,
      );
      index = entries.length - 1;
      emit();
    },
    resolve(target) {
      if (disposed) return;
      entries[index] = Object.freeze({
        id: snapshot.current.id,
        target: parseOpenTarget(target),
      });
      emit();
    },
    replace(target) {
      if (disposed) return;
      entries[index] = navigationEntry(target);
      emit();
    },
    back() {
      if (disposed || index === 0) return;
      index--;
      emit();
    },
    forward() {
      if (disposed || index === entries.length - 1) return;
      index++;
      emit();
    },
    dispose() {
      disposed = true;
      controller = undefined;
    },
  };
}
