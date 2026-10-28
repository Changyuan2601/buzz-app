// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mediaCornerPath } from "./media-corners";
import { useMediaCorners } from "./use-media-corners";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Media({ id }: { id: string }) {
  const corners = useMediaCorners();
  return (
    <div data-testid={id} ref={corners}>
      <svg data-image-outline="" aria-hidden="true">
        <path />
      </svg>
    </div>
  );
}

it("leaves media corner measurement to the resize observer's first report", () => {
  const reports = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      element?: Element;
      constructor(readonly callback: ResizeObserverCallback) {}
      observe(element: Element) {
        this.element = element;
        reports.set(element, this.callback);
      }
      disconnect() {
        if (this.element) reports.delete(this.element);
      }
    },
  );
  const reads: number[] = [];
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    () => {
      reads.push(document.querySelectorAll("[data-smooth-corners]").length);
      return 40;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    borderTopLeftRadius: "8px",
  } as CSSStyleDeclaration);

  const view = render(
    <>
      <Media id="first" />
      <Media id="second" />
    </>,
  );
  const elements = [view.getByTestId("first"), view.getByTestId("second")];
  // Mounting leaves measurement to the observer's first report.
  expect(reads).toEqual([]);
  expect([...reports.keys()]).toEqual(elements);

  for (const target of elements)
    reports.get(target)?.(
      [{ target } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  expect(reads).toEqual([0, 1]);
  const path = mediaCornerPath(40, 20, 8);
  for (const element of elements) {
    expect(element.dataset.smoothCorners).toBe("");
    expect(element.style.getPropertyValue("--media-corner-clip")).toBe(
      `path("${path}")`,
    );
    expect(element.querySelector("path")?.getAttribute("d")).toBe(path);
  }

  view.unmount();
  expect(reports.size).toBe(0);
  for (const element of elements) {
    expect(element.dataset.smoothCorners).toBeUndefined();
    expect(element.style.getPropertyValue("--media-corner-clip")).toBe("");
  }
});
