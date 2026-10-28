// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useKeyboardFocusVisibility } from "../../../shared/design-system/useKeyboardFocusVisibility";
import { EffortSlider } from "./EffortSlider";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

afterEach(() => {
  delete document.documentElement.dataset.keyboardInput;
});

function Slider() {
  useKeyboardFocusVisibility();
  return (
    <EffortSlider
      name="Agent"
      avatarSrc={undefined}
      model={() => null}
      efforts={[
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ]}
      resting="low"
      value={undefined}
      disabled={false}
      pick={() => {}}
    />
  );
}

it("follows the app's keyboard-input modality on the slider root", async () => {
  // Pinned by the transition rule, which keys on the slider's own attribute.
  document.documentElement.dataset.keyboardInput = "";
  const { container } = render(<Slider />);
  const slider = () => container.querySelector("[data-keyboard]");
  expect(slider()).not.toBeNull();
  await act(async () => {
    fireEvent.pointerDown(document.body);
  });
  expect(slider()).toBeNull();
  await act(async () => {
    fireEvent.keyDown(document.body, { key: "a" });
  });
  expect(slider()).not.toBeNull();
});
