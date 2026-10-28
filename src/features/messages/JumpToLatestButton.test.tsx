// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createJumpToLatest, JumpToLatestControl } from "./JumpToLatestButton";

afterEach(cleanup);

it("shows the control and marks its scroller in the same commit, and only for changes", () => {
  const state = createJumpToLatest();
  const scroller = createRef<HTMLElement>();
  const listener = vi.fn();
  state.subscribe(listener);
  render(
    <section ref={scroller}>
      <JumpToLatestControl
        state={state}
        scroller={scroller}
        onClick={() => {}}
      />
    </section>,
  );
  const control = () => scroller.current?.querySelector("[data-visible]");
  const button = () => scroller.current?.querySelector("[data-jump-to-latest]");
  expect(control()).toHaveAttribute("data-visible", "false");
  expect(scroller.current).not.toHaveAttribute("data-jump-visible");

  act(() => state.set({ visible: true }));
  expect(button()).toHaveTextContent("Jump to latest");
  expect(control()).toHaveAttribute("data-visible", "true");
  expect(scroller.current).toHaveAttribute("data-jump-visible");

  act(() => state.set({ visible: true }));
  expect(listener).toHaveBeenCalledTimes(1);

  act(() => state.set({ newMessageCount: 2 }));
  expect(button()).toHaveTextContent("2 new messages");

  act(() => state.set({ visible: false, newMessageCount: 0 }));
  expect(scroller.current).not.toHaveAttribute("data-jump-visible");
  expect(listener).toHaveBeenCalledTimes(3);
});
