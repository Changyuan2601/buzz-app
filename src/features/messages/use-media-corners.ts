import { useCallback } from "react";
import { mediaCornerPath } from "./media-corners";

type Measured = {
  element: HTMLElement;
  width: number;
  height: number;
  radius: number;
};

// Media mounted in one commit is measured together before the next frame:
// a write between reads would force a layout of the whole history per item.
let mounted: HTMLElement[] = [];

function measure(element: HTMLElement): Measured | undefined {
  const { offsetWidth: width, offsetHeight: height } = element;
  if (!width || !height) return;
  const radius = Number.parseFloat(
    getComputedStyle(element).borderTopLeftRadius,
  );
  return { element, width, height, radius };
}

function apply({ element, width, height, radius }: Measured) {
  const path = mediaCornerPath(width, height, radius || 0);
  const clip = `path("${path}")`;
  if (element.style.getPropertyValue("--media-corner-clip") !== clip)
    element.style.setProperty("--media-corner-clip", clip);
  // Set the SVG attribute so the outline does not depend on CSS d support.
  const outline = element.querySelector("[data-image-outline] path");
  if (outline && outline.getAttribute("d") !== path)
    outline.setAttribute("d", path);
  if (element.dataset.smoothCorners === undefined)
    element.dataset.smoothCorners = "";
}

function flushMounted() {
  const elements = mounted;
  mounted = [];
  const measured = elements
    .filter((element) => element.isConnected)
    .map(measure);
  for (const entry of measured) if (entry) apply(entry);
}

/** CSS chooses where to clip, so floating menus can escape the media surface. */
export function useMediaCorners() {
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      const entry = measure(element);
      if (entry) apply(entry);
    };
    if (!mounted.length) queueMicrotask(flushMounted);
    mounted.push(element);
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer.disconnect();
      mounted = mounted.filter((item) => item !== element);
      element.style.removeProperty("--media-corner-clip");
      delete element.dataset.smoothCorners;
    };
  }, []);
}
