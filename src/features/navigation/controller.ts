import {
  pageKey,
  parseOpenTarget,
  stripPresentation,
  targetKey,
  type OpenTarget,
  type OverlayKeys,
} from "./targets";
import type { NavigationEntry, NavigationHistory } from "./history";

/**
 * Shared abort reason. A reason-less abort() makes Blink mint a DOMException per
 * call, and V8 keeps its unformatted stack alive: that stack holds the start()
 * scope (so the next attempt) and the click dispatch (so the unmounted DOM).
 * One instance captures no per-abort stack, so its .stack points at module
 * evaluation, not the aborting site: do not use it for diagnostics.
 */
export const NAVIGATION_ABORTED = new DOMException(
  "Navigation attempt aborted",
  "AbortError",
);

export type OpenFailure =
  | "invalid-target"
  | "unavailable"
  | "denied"
  | "not-found"
  | "timeout"
  | "host-error";
export type OpenResult = Readonly<
  | { status: "opened" }
  | { status: "cancelled" | "superseded" }
  | { status: "failed"; reason: OpenFailure }
>;
/** Focus is per opening, never part of a saved address or history entry. */
export type NavigationFocus = "content" | "preserve";
export type NavigationOpenOptions = {
  replace?: boolean;
  focus?: NavigationFocus;
};
export type OpenAttempt = Readonly<{
  id: string;
  entry: NavigationEntry;
  signal: AbortSignal;
  focus?: NavigationFocus;
}>;
export type NavigationSnapshot = Readonly<{
  entry: NavigationEntry;
  attempt: OpenAttempt;
  status: "opening" | OpenResult["status"];
  reason?: OpenFailure;
  /** An incoming URL failed before it could create a history destination. */
  ingress?: boolean;
  retryable?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}>;
export type Navigation = Readonly<{
  snapshot(): NavigationSnapshot;
  subscribe(listener: () => void): () => void;
  open(
    target: OpenTarget,
    options?: NavigationOpenOptions,
  ): Promise<OpenResult>;
  back(): void;
  forward(): void;
  retry(): Promise<OpenResult>;
}>;

/**
 * The host alone receives completion/cancellation authority. Plugins get Navigation.
 * `overlay` names the route params a page presents as a dialog, so the controller
 * can keep that page's dialogs out of history without knowing the page.
 */
export function createNavigationController(
  history: NavigationHistory,
  timeoutMs = 15_000,
  overlay?: OverlayKeys,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid open timeout");
  type Operation = {
    attempt: OpenAttempt;
    controller: AbortController;
    promise: Promise<OpenResult>;
    resolve: (result: OpenResult) => void;
    pending: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  let disposed = false;
  let active: Operation;
  let snapshot: NavigationSnapshot;
  let ingressRetry: (() => Promise<OpenResult>) | undefined;
  const listeners = new Set<() => void>();
  // Commit state and capture each caller's result before invoking external code.
  // Reentrant opens run against committed state and own their own result; deferred
  // abort/notification effects never resume a half-written state transition.
  let depth = 0;
  let draining = false;
  const effects: (() => void)[] = [];
  function transaction<T>(run: () => T): T {
    depth++;
    try {
      return run();
    } finally {
      depth--;
      if (!depth && !draining) {
        draining = true;
        try {
          while (effects.length) effects.shift()?.();
        } finally {
          draining = false;
        }
      }
    }
  }
  const emit = () =>
    effects.push(() => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          console.error("Navigation observer failed");
        }
      }
    });
  function settle(operation: Operation, result: OpenResult) {
    if (!operation.pending) return;
    operation.pending = false;
    clearTimeout(operation.timer);
    operation.resolve(result);
  }
  function finish(operation: Operation, result: OpenResult) {
    if (operation !== active || !operation.pending) return;
    settle(operation, result);
    snapshot = Object.freeze({
      ...snapshot,
      status: result.status,
      ...(result.status === "failed" ? { reason: result.reason } : {}),
    });
    if (result.status !== "opened")
      effects.push(() => operation.controller.abort(NAVIGATION_ABORTED));
    emit();
  }
  function start(focus: NavigationFocus = "content"): Promise<OpenResult> {
    if (disposed) return Promise.resolve({ status: "cancelled" });
    ingressRetry = undefined;
    const old = active;
    if (old) {
      settle(old, { status: "superseded" });
      effects.push(() => old.controller.abort(NAVIGATION_ABORTED));
    }
    const controller = new AbortController();
    const state = history.snapshot();
    const attempt: OpenAttempt = Object.freeze({
      id: crypto.randomUUID(),
      entry: state.current,
      signal: controller.signal,
      focus,
    });
    let resolve: (result: OpenResult) => void = () => {};
    const promise = new Promise<OpenResult>((settle) => {
      resolve = settle;
    });
    const operation: Operation = {
      attempt,
      controller,
      promise,
      resolve,
      pending: true,
    };
    active = operation;
    snapshot = Object.freeze({
      entry: state.current,
      attempt,
      status: "opening",
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
    });
    if (state.invalidAddress) {
      finish(operation, { status: "failed", reason: "invalid-target" });
      return promise;
    }
    operation.timer = setTimeout(
      () =>
        transaction(() => {
          finish(operation, { status: "failed", reason: "timeout" });
        }),
      timeoutMs,
    );
    emit();
    return promise;
  }
  let resolving: Operation | undefined;
  // Both host drivers publish pushes synchronously; consume this opening only.
  let openingFocus: NavigationFocus | undefined;
  const unsubscribe = history.attach(() => {
    transaction(() => {
      if (resolving && active === resolving) {
        // Domain normalization keeps the caller, visit, signal and original deadline.
        // Rotate the immutable attempt token so an old presentation cannot complete it.
        const state = history.snapshot();
        active.attempt = Object.freeze({
          ...active.attempt,
          entry: state.current,
        });
        snapshot = Object.freeze({
          ...snapshot,
          entry: state.current,
          attempt: active.attempt,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
        });
        emit();
      } else {
        const focus = openingFocus;
        openingFocus = undefined;
        start(focus);
      }
    });
  });
  transaction(start);
  const navigation: Navigation = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(input: OpenTarget, options?: NavigationOpenOptions) {
      return transaction(() => {
        if (disposed)
          return Promise.resolve<OpenResult>({ status: "cancelled" });
        let target: OpenTarget;
        try {
          target = parseOpenTarget(input);
        } catch {
          return Promise.resolve<OpenResult>({
            status: "failed",
            reason: "invalid-target",
          });
        }
        try {
          const { current, invalidAddress } = history.snapshot();
          if (
            !invalidAddress &&
            targetKey(target) === targetKey(current.target)
          )
            return start(options?.focus);
          openingFocus = options?.focus;
          // Opening or closing a dialog on the current page changes presentation,
          // not the visit: write it into that visit (so reload and deep links
          // restore it, and its identity holds) and never let a page push a
          // Back/Forward destination for it.
          if (
            !invalidAddress &&
            pageKey(target, overlay) === pageKey(current.target, overlay)
          )
            history.resolve(target);
          else if (options?.replace) history.replace(target);
          else {
            // Leaving a page from under its dialog dismisses the dialog: the
            // departing visit keeps its identity but not the presentation, so
            // Back returns to the page alone rather than reopening it.
            if (!invalidAddress) {
              const page = stripPresentation(current.target, overlay);
              if (targetKey(page) !== targetKey(current.target)) {
                resolving = active;
                try {
                  history.resolve(page);
                } finally {
                  resolving = undefined;
                }
              }
            }
            history.push(target);
          }
          return active.promise;
        } catch {
          // Drivers commit atomically and notify only their exclusive controller.
          return Promise.resolve<OpenResult>({
            status: "failed",
            reason: "host-error",
          });
        } finally {
          openingFocus = undefined;
        }
      });
    },
    back() {
      transaction(() => {
        if (!disposed) history.back();
      });
    },
    forward() {
      transaction(() => {
        if (!disposed) history.forward();
      });
    },
    retry() {
      if (snapshot.ingress) {
        if (disposed) return Promise.resolve({ status: "cancelled" as const });
        return (
          ingressRetry?.() ??
          Promise.resolve<OpenResult>({
            status: "failed",
            reason: snapshot.reason ?? "invalid-target",
          })
        );
      }
      return transaction(() => start(snapshot.attempt.focus));
    },
  });
  return {
    navigation,
    /** Normalize a pending presentation, not a new intent; never reset its deadline. */
    resolve(attempt: OpenAttempt, input: OpenTarget) {
      return transaction(() => {
        if (
          disposed ||
          attempt !== active.attempt ||
          attempt.signal.aborted ||
          !active.pending
        )
          return false;
        try {
          const target = parseOpenTarget(input);
          if (targetKey(target) === targetKey(snapshot.entry.target))
            return true;
          resolving = active;
          history.resolve(target);
          return true;
        } catch {
          return false;
        } finally {
          resolving = undefined;
        }
      });
    },
    /** Acknowledge only the exact active attempt after actual presentation. */
    complete(
      attempt: OpenAttempt,
      result: Extract<OpenResult, { status: "opened" | "failed" }>,
    ) {
      return transaction(() => {
        if (
          disposed ||
          attempt !== active.attempt ||
          attempt.signal.aborted ||
          !active.pending
        )
          return false;
        finish(active, result);
        return true;
      });
    },
    cancel() {
      transaction(() => {
        ingressRetry = undefined;
        const operation = active;
        finish(operation, { status: "cancelled" });
        effects.push(() => operation.controller.abort(NAVIGATION_ABORTED));
      });
    },
    /** Keep pre-navigation recovery separate from the previous history visit. */
    fail(reason: OpenFailure, retry?: () => Promise<OpenResult>) {
      transaction(() => {
        if (disposed) return;
        void start();
        ingressRetry = retry;
        snapshot = Object.freeze({
          ...snapshot,
          ingress: true,
          retryable: !!retry,
        });
        finish(active, { status: "failed", reason });
      });
    },
    dispose() {
      transaction(() => {
        if (disposed) return;
        disposed = true;
        ingressRetry = undefined;
        unsubscribe();

        finish(active, { status: "cancelled" });
        const operation = active;
        effects.push(() => operation.controller.abort(NAVIGATION_ABORTED));
        listeners.clear();
        history.dispose();
      });
    },
  };
}
