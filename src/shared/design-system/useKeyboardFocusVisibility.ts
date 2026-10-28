import { useEffect } from "react";

const KEYBOARD_NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

// The focused element mirrors the modality for the outline gate, so a
// modality switch restyles that element rather than the whole document.
function markFocus(element: EventTarget | null, keyboard: boolean) {
  if (element instanceof Element)
    element.toggleAttribute("data-keyboard-focus", keyboard);
}

/** Explicit keyboard focus actions also use this owner after being rebound. */
function showKeyboardFocus() {
  document.documentElement.dataset.keyboardNavigation = "";
  markFocus(document.activeElement, true);
}

export function focusWithKeyboard(element: HTMLElement) {
  showKeyboardFocus();
  // Chromium ignores focus options when the control is already focused.
  if (document.activeElement === element && !element.matches(":focus-visible"))
    element.blur();
  const options: FocusOptions & { focusVisible: boolean } = {
    preventScroll: true,
    focusVisible: true,
  };
  element.focus(options);
}

/**
 * Makes keyboard focus visible without treating a pointer click in a text field
 * as keyboard navigation. Browsers intentionally match :focus-visible for text
 * inputs even after a click, so this app-level modality fact gates the visual
 * treatment consistently for every control.
 */
export function useKeyboardFocusVisibility() {
  useEffect(() => {
    const root = document.documentElement;
    const follow = (event: FocusEvent) =>
      markFocus(event.target, root.hasAttribute("data-keyboard-navigation"));
    const leave = (event: FocusEvent) => markFocus(event.target, false);
    const useKeyboardNavigation = (event: KeyboardEvent) => {
      // Motion follows every keyboard action; focus styling keeps its narrower policy.
      root.dataset.keyboardInput = "";
      if (
        KEYBOARD_NAVIGATION_KEYS.has(event.key) &&
        !event.metaKey &&
        // Alt+Tab and Ctrl+Tab move focus between windows and tabs.
        (!event.ctrlKey || event.key === "Tab") &&
        (!event.altKey || event.key === "Tab")
      ) {
        showKeyboardFocus();
      }
    };
    const usePointerNavigation = () => {
      delete root.dataset.keyboardNavigation;
      delete root.dataset.keyboardInput;
      markFocus(document.activeElement, false);
    };

    window.addEventListener("keydown", useKeyboardNavigation, true);
    window.addEventListener("pointerdown", usePointerNavigation, true);
    window.addEventListener("touchstart", usePointerNavigation, true);
    window.addEventListener("focusin", follow, true);
    window.addEventListener("focusout", leave, true);
    return () => {
      window.removeEventListener("focusin", follow, true);
      window.removeEventListener("focusout", leave, true);
      markFocus(document.activeElement, false);
      window.removeEventListener("keydown", useKeyboardNavigation, true);
      window.removeEventListener("pointerdown", usePointerNavigation, true);
      window.removeEventListener("touchstart", usePointerNavigation, true);
      delete root.dataset.keyboardNavigation;
      delete root.dataset.keyboardInput;
    };
  }, []);
}
