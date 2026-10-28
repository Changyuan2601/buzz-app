import { useCallback } from "react";
import { mediaCornerPath } from "./media-corners";

type Geometry = { width: number; height: number; radius: number };
const observed = new Map<HTMLElement, Geometry | undefined>();
let observer: ResizeObserver | undefined;

function sync(entries: ResizeObserverEntry[]) {
  // Read the entire resize batch before invalidating styles on any preview.
  const updates = [];
  for (const entry of entries) {
    const element = entry.target as HTMLElement;
    if (!observed.has(element)) continue;
    const { offsetWidth: width, offsetHeight: height } = element;
    if (!width || !height) continue;
    const radius =
      Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    const previous = observed.get(element);
    if (
      previous?.width === width &&
      previous.height === height &&
      previous.radius === radius
    )
      continue;
    const geometry = { width, height, radius };
    observed.set(element, geometry);
    updates.push({ element, ...geometry });
  }
  for (const { element, width, height, radius } of updates) {
    const path = mediaCornerPath(width, height, radius);
    const clip = `path("${path}")`;
    if (element.style.getPropertyValue("--media-corner-clip") !== clip)
      element.style.setProperty("--media-corner-clip", clip);
    // Set the SVG attribute so the outline does not depend on CSS d support.
    element.querySelector("[data-image-outline] path")?.setAttribute("d", path);
    element.dataset.smoothCorners = "";
  }
}

/** CSS chooses where to clip, so floating menus can escape the media surface. */
export function useMediaCorners() {
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    // Initial ResizeObserver delivery runs after layout and before paint, so
    // newly mounted previews share the read phase without a frame of delay.
    observer ??= new ResizeObserver(sync);
    observed.set(element, undefined);
    observer.observe(element);
    return () => {
      observer?.unobserve(element);
      observed.delete(element);
      if (!observed.size) {
        observer?.disconnect();
        observer = undefined;
      }
      element.style.removeProperty("--media-corner-clip");
      delete element.dataset.smoothCorners;
    };
  }, []);
}
