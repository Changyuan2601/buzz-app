// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mediaCornerClip } from "./media-corners";
import { useMediaCorners } from "./use-media-corners";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Media() {
  return <div data-testid="media" ref={useMediaCorners()} />;
}

it("leaves mount-time measurement to the observer's first report", () => {
  const reports: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(report: () => void) {
        reports.push(report);
      }
      observe() {}
      disconnect() {}
    },
  );
  const width = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  const { getByTestId } = render(<Media />);
  const media = getByTestId("media");
  expect(width).not.toHaveBeenCalled();
  expect(media.dataset.smoothCorners).toBeUndefined();

  for (const report of reports) report();
  expect(media.dataset.smoothCorners).toBe("");
  expect(media.style.getPropertyValue("--media-corner-clip")).toBe(
    mediaCornerClip(120, 80, 0),
  );
});
