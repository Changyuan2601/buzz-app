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

it("mirrors keyboard modality onto the focused element only", async () => {
  const root = document.documentElement;
  const hook = renderHook(() => useKeyboardFocusVisibility());
  const first = document.body.appendChild(document.createElement("button"));
  const second = document.body.appendChild(document.createElement("button"));
  // The modality observer delivers its records as a microtask.
  const marked = async () => {
    await Promise.resolve();
    return [first, second].filter((element) =>
      element.hasAttribute("data-keyboard-focus"),
    );
  };
  try {
    first.focus();
    expect(await marked()).toEqual([]);
    fireEvent.keyDown(first, { key: "Tab" });
    expect(await marked()).toEqual([first]);
    second.focus();
    expect(await marked()).toEqual([second]);
    fireEvent.pointerDown(second);
    expect(await marked()).toEqual([]);
    first.focus();
    expect(await marked()).toEqual([]);
    root.dataset.keyboardNavigation = "";
    expect(await marked()).toEqual([first]);
    fireEvent.pointerDown(first);
    focusWithKeyboard(first);
    expect(await marked()).toEqual([first]);
    hook.unmount();
    expect(await marked()).toEqual([]);
  } finally {
    first.remove();
    second.remove();
  }
});
