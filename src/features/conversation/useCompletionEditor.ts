import type { ComposerInputElement } from "../messages/composer-dom";
import {
  useLayoutEffect,
  useCallback,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
} from "react";
import type { ComposerObservation } from "./contracts";

/** One synchronous invalidation owner; stale React closures cannot revive an edit. */
export function useCompletionEditor(
  input: RefObject<ComposerInputElement | null>,
  enabled: boolean,
) {
  // Only the completion leaf reads the observation; keeping it out of the
  // composer's state keeps caret moves and keystrokes from rendering the
  // composer chrome.
  const [observed] = useState(observationStore);
  const current = useRef<ComposerObservation | undefined>(undefined);
  const revision = useRef(0);
  const last = useRef<ComposerObservation | undefined>(undefined);
  const composing = useRef(false);
  const keys = useRef<
    ((event: KeyboardEvent<ComposerInputElement>) => boolean) | undefined
  >(undefined);
  const invalidate = useCallback(() => {
    ++revision.current;
    current.current = undefined;
    observed.set(undefined);
  }, [observed]);
  function observe(force = false) {
    const element = input.current;
    if (
      !enabled ||
      !element?.isConnected ||
      element.disabled ||
      element.readOnly ||
      element.ownerDocument.activeElement !== element ||
      composing.current ||
      element.selectionStart !== element.selectionEnd
    ) {
      // Returning from an ineligible selection needs fresh evidence, even at the
      // same caret. Explicit dismissal keeps `last` to ignore redundant events.
      last.current = undefined;
      if (current.current) invalidate();
      return;
    }
    const previous = last.current;
    if (
      !force &&
      previous?.text === element.value &&
      previous.start === element.selectionStart &&
      previous.end === element.selectionEnd
    )
      return;
    const next = Object.freeze({
      revision: ++revision.current,
      text: element.value,
      start: element.selectionStart,
      end: element.selectionEnd,
    });
    last.current = next;
    current.current = next;
    observed.set(next);
  }
  function valid(expected: ComposerObservation) {
    const element = input.current;
    return (
      current.current === expected &&
      enabled &&
      !!element?.isConnected &&
      !element.disabled &&
      !element.readOnly &&
      !composing.current &&
      element.ownerDocument.activeElement === element &&
      element.value === expected.text &&
      element.selectionStart === expected.start &&
      element.selectionEnd === expected.end
    );
  }
  function revalidate() {
    // Rich tokens rebuild before their caret is restored. Revoke stale evidence
    // here; select/selectionchange observes the settled selection. Publishing a
    // new observation during that rebuild can drive a render/selection loop.
    if (current.current && !valid(current.current)) {
      last.current = undefined;
      invalidate();
    }
  }
  useLayoutEffect(revalidate);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const select = () => observe();
    element.addEventListener("select", select);
    element.ownerDocument.addEventListener("selectionchange", select);
    return () => {
      element.removeEventListener("select", select);
      element.ownerDocument.removeEventListener("selectionchange", select);
    };
  });
  useLayoutEffect(() => {
    if (!enabled) invalidate();
    return () => {
      current.current = undefined;
      ++revision.current;
    };
  }, [enabled, invalidate]);
  return { observed, valid, revalidate, observe, invalidate, keys, composing };
}
function observationStore() {
  let observation: ComposerObservation | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => observation,
    set(next: ComposerObservation | undefined) {
      if (observation === next) return;
      observation = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type CompletionEditor = Omit<
  ReturnType<typeof useCompletionEditor>,
  "observed" | "revalidate"
> & { observation: ComposerObservation | undefined };
