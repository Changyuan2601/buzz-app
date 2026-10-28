// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mediaCornerPath } from "./media-corners";
import { useMediaCorners } from "./use-media-corners";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Media({ id }: { id: string }) {
  return <div data-testid={id} ref={useMediaCorners()} />;
}

it("measures media mounted together before writing any clip", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const log: string[] = [];
  const size = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(function (this: HTMLElement) {
      const written = document.querySelectorAll("[data-smooth-corners]");
      log.push(`${this.dataset.testid} after ${written.length} writes`);
      return 40;
    });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30);
  const view = render(
    <>
      <Media id="first" />
      <Media id="second" />
    </>,
  );
  expect(size).not.toHaveBeenCalled();
  await Promise.resolve();
  const first = view.getByTestId("first");
  const second = view.getByTestId("second");
  expect(log).toEqual(["first after 0 writes", "second after 0 writes"]);
  const clip = `path("${mediaCornerPath(40, 30, 0)}")`;
  for (const element of [first, second]) {
    expect(element.style.getPropertyValue("--media-corner-clip")).toBe(clip);
    expect(element).toHaveProperty("dataset.smoothCorners", "");
  }
});

it("skips media detached before its batch runs", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const size = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30);
  const view = render(<Media id="gone" />);
  const element = view.getByTestId("gone");
  view.unmount();
  await Promise.resolve();
  expect(size).not.toHaveBeenCalled();
  expect(element.style.getPropertyValue("--media-corner-clip")).toBe("");
  expect(element.dataset.smoothCorners).toBeUndefined();
});
