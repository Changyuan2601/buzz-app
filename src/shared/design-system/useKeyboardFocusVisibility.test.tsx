// @vitest-environment jsdom
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  focusWithKeyboard,
  useKeyboardFocusVisibility,
} from "./useKeyboardFocusVisibility";

afterEach(() => {
  delete document.documentElement.dataset.keyboardNavigation;
});

it("explicit keyboard focus actions show the shared indicator and pointer use resets it", () => {
  const hook = renderHook(() => useKeyboardFocusVisibility());
  const button = document.createElement("button");
  document.body.append(button);
  for (let i = 0; i < 2; i++) {
    fireEvent.pointerDown(document.body);
    expect(document.documentElement.dataset.keyboardNavigation).toBeUndefined();
    focusWithKeyboard(button);
    expect(document.activeElement).toBe(button);
    expect(document.documentElement.dataset.keyboardNavigation).toBe("");
  }
  hook.unmount();
  button.remove();
});

it("treats Ctrl+Tab after a pointer as keyboard navigation, but not other Ctrl chords", () => {
  const root = document.documentElement;
  const hook = renderHook(() => useKeyboardFocusVisibility());
  for (const init of [
    { key: "Tab", ctrlKey: true },
    { key: "Tab", ctrlKey: true, shiftKey: true },
  ]) {
    fireEvent.pointerDown(document.body);
    expect(root.dataset.keyboardNavigation).toBeUndefined();
    fireEvent.keyDown(document.body, init);
    expect(root.dataset.keyboardNavigation).toBe("");
  }
  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "ArrowDown", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "Tab", metaKey: true });
  expect(root.dataset.keyboardNavigation).toBeUndefined();
  hook.unmount();
});

it("marks only the focused element with keyboard modality", () => {
  const hook = renderHook(() => useKeyboardFocusVisibility());
  const first = document.body.appendChild(document.createElement("button"));
  const second = document.body.appendChild(document.createElement("button"));
  const marked = () =>
    [first, second].filter((element) =>
      element.hasAttribute("data-keyboard-focus"),
    );
  try {
    first.focus();
    expect(marked()).toEqual([]);
    fireEvent.keyDown(first, { key: "Tab" });
    expect(marked()).toEqual([first]);
    second.focus();
    expect(marked()).toEqual([second]);
    fireEvent.pointerDown(second);
    expect(marked()).toEqual([]);
    first.focus();
    expect(marked()).toEqual([]);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(marked()).toEqual([first]);
    fireEvent.pointerDown(first);
    focusWithKeyboard(first);
    expect(marked()).toEqual([first]);
    hook.unmount();
    expect(marked()).toEqual([]);
  } finally {
    first.remove();
    second.remove();
  }
});
