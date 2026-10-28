import { useCallback } from "react";
import { mediaCornerPath } from "./media-corners";

let observer: ResizeObserver | undefined;

/** One observer serves every preview: its first notification arrives before
 * paint, and each batch measures all previews before writing any of them, so
 * mounting a gallery or thread costs one layout instead of one per preview. */
function sync(entries: ResizeObserverEntry[]) {
  const corners = entries.map(({ target }) => {
    const element = target as HTMLElement;
    const { offsetWidth: width, offsetHeight: height } = element;
    if (!width || !height) return undefined;
    const radius = Number.parseFloat(
      getComputedStyle(element).borderTopLeftRadius,
    );
    return { element, path: mediaCornerPath(width, height, radius || 0) };
  });
  for (const corner of corners) {
    if (!corner) continue;
    const { element, path } = corner;
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
    observer ??= new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer?.unobserve(element);
      element.style.removeProperty("--media-corner-clip");
      delete element.dataset.smoothCorners;
    };
  }, []);
}
