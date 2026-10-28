// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useCallback } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMediaCorners } from "./use-media-corners";

const observations = new Map<ResizeObserverCallback, Set<Element>>();

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {
        observations.set(callback, new Set());
      }
      observe(element: Element) {
        observations.get(this.callback)?.add(element);
      }
      unobserve(element: Element) {
        observations.get(this.callback)?.delete(element);
      }
      disconnect() {
        observations.get(this.callback)?.clear();
      }
    },
  );
});

afterEach(() => {
  cleanup();
  observations.clear();
  vi.unstubAllGlobals();
});

// jsdom has no layout or observer delivery. This local shim supplies only the
// browser boundary; real layout/clipping is covered by video-preview-sizing.
function Preview({
  width,
  height,
  radius = 24,
}: {
  width: number;
  height: number;
  radius?: number;
}) {
  const corners = useMediaCorners();
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (element)
        Object.defineProperties(element, {
          offsetWidth: {
            configurable: true,
            get: () => Number.parseFloat(element.style.width),
          },
          offsetHeight: {
            configurable: true,
            get: () => Number.parseFloat(element.style.height),
          },
        });
      return corners(element);
    },
    [corners],
  );
  return (
    <div ref={ref} style={{ width, height, borderTopLeftRadius: radius }}>
      <svg data-image-outline="" aria-hidden="true">
        <path />
      </svg>
    </div>
  );
}

function resize() {
  act(() => {
    for (const [callback, targets] of observations)
      if (targets.size)
        callback(
          [...targets].map((target) => ({ target }) as ResizeObserverEntry),
          {} as ResizeObserver,
        );
  });
}

function path(element: HTMLElement) {
  const outline = element.querySelector("path")?.getAttribute("d");
  expect(outline).toMatch(/^M /);
  expect(outline).not.toMatch(/NaN|Infinity/);
  expect(element.style.getPropertyValue("--media-corner-clip")).toBe(
    `path("${outline}")`,
  );
  expect(element.hasAttribute("data-smooth-corners")).toBe(true);
  return outline;
}

it("keeps each preview's clip and outline aligned through resize, radius change and sibling removal", () => {
  function Previews({ first = true, width = 100, radius = 24 }) {
    return (
      <StrictMode>
        {first && <Preview key="first" width={80} height={80} />}
        <Preview key="second" width={width} height={60} radius={radius} />
      </StrictMode>
    );
  }
  const view = render(<Previews />);
  resize();
  const [first, second] = Array.from(view.container.children) as [
    HTMLElement,
    HTMLElement,
  ];
  const initial = path(second);
  expect(path(first)).not.toBe(initial);
  view.rerender(<Previews width={120} />);
  resize();
  const wider = path(second);
  expect(wider).not.toBe(initial);
  view.rerender(<Previews width={120} radius={12} />);
  resize();
  const smallerRadius = path(second);
  expect(smallerRadius).not.toBe(wider);
  view.rerender(<Previews first={false} width={140} radius={12} />);
  resize();
  expect(path(second)).not.toBe(smallerRadius);
  expect(first.style.getPropertyValue("--media-corner-clip")).toBe("");
  expect(first.hasAttribute("data-smooth-corners")).toBe(false);
  view.unmount();
  expect(second.style.getPropertyValue("--media-corner-clip")).toBe("");
  expect(second.hasAttribute("data-smooth-corners")).toBe(false);
});

it("waits for usable geometry and recovers from a zero-size interval with finite tiny corners", () => {
  const view = render(<Preview width={0} height={0} />);
  const element = view.container.firstElementChild as HTMLElement;
  resize();
  expect(element.hasAttribute("data-smooth-corners")).toBe(false);
  view.rerender(<Preview width={1} height={1} />);
  resize();
  const tiny = path(element);
  view.rerender(<Preview width={0} height={0} />);
  resize();
  expect(path(element)).toBe(tiny);
  view.rerender(<Preview width={80} height={40} />);
  resize();
  expect(path(element)).not.toBe(tiny);
});
