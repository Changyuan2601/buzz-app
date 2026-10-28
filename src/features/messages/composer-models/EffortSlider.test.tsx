// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EffortSlider } from "./EffortSlider";

afterEach(() => {
  delete document.documentElement.dataset.keyboardInput;
  vi.unstubAllGlobals();
});

it("mirrors document keyboard input onto the slider for its snap rule", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const root = document.documentElement;
  root.dataset.keyboardInput = "";
  const view = render(
    <EffortSlider
      name="Ada"
      avatarSrc={undefined}
      model={() => "Model"}
      efforts={[
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ]}
      resting="low"
      value={undefined}
      disabled={false}
      pick={() => {}}
    />,
  );
  const slider = view.container.firstElementChild as HTMLElement;
  // The document observer delivers its records as a microtask.
  const snapping = async () => {
    await Promise.resolve();
    return slider.hasAttribute("data-keyboard-snap");
  };
  expect(await snapping()).toBe(true);
  delete root.dataset.keyboardInput;
  expect(await snapping()).toBe(false);
  root.dataset.keyboardInput = "";
  expect(await snapping()).toBe(true);
  view.unmount();
});
