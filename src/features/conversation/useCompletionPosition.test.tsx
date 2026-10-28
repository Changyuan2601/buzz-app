// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import type { ComposerInputElement } from "../messages/composer-dom";
import { useCompletionPosition } from "./useCompletionPosition";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Menu() {
  const input = useRef<HTMLDivElement>(null);
  const popup = useCompletionPosition(
    input as RefObject<ComposerInputElement | null>,
    1,
    { preferAbove: true, gap: 4 },
  );
  return (
    <form>
      <div ref={input} />
      <section ref={popup} aria-label="Suggestions" />
    </form>
  );
}

it("places the menu from the anchor observation, not a layout read during commit", () => {
  const notify: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const rect = vi
    .spyOn(HTMLFormElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      top: 600,
      bottom: 640,
      left: 20,
      right: 320,
      width: 300,
      height: 40,
    } as DOMRect);
  const view = render(<Menu />);
  const menu = view.getByLabelText("Suggestions");
  expect(rect).not.toHaveBeenCalled();
  // Browsers report a new observation after layout and before paint.
  act(() => notify.at(-1)?.());
  expect(rect).toHaveBeenCalledTimes(1);
  expect(menu.style).toMatchObject({
    left: "20px",
    top: "596px",
    width: "300px",
    transform: "translateY(-100%)",
  });
  rect.mockRestore();
});
