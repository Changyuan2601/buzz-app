// Source fixtures have no host modality owner. Emulate its state after a real
// keyboard input: the root attribute, mirrored onto the focused element as the
// marker focus recipes key on (see useKeyboardFocusVisibility).
export function emulateKeyboardNavigation(page, enabled = true) {
  return page.evaluate((enabled) => {
    const root = document.documentElement;
    const mark = (target) => {
      if (target instanceof Element)
        target.toggleAttribute(
          "data-keyboard-focus",
          root.hasAttribute("data-keyboard-navigation"),
        );
    };
    if (!window.__emulatedKeyboardFocus) {
      window.__emulatedKeyboardFocus = true;
      window.addEventListener("focusin", (event) => mark(event.target), true);
      window.addEventListener(
        "focusout",
        (event) => event.target.removeAttribute?.("data-keyboard-focus"),
        true,
      );
    }
    root.toggleAttribute("data-keyboard-navigation", enabled);
    mark(document.activeElement);
  }, enabled);
}
