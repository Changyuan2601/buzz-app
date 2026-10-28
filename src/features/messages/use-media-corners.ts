import { useCallback } from "react";
import { mediaCornerPath } from "./media-corners";

type Measure = () => (() => void) | undefined;

// Media mounted in one commit is measured together before any clip is written.
// Measuring each on attach made every write force the next element's style and
// layout again; the microtask still runs before the frame renders.
let mounting: Measure[] = [];
function measureOnMount(measure: Measure) {
  if (mounting.push(measure) > 1) return;
  queueMicrotask(() => {
    const batch = mounting;
    mounting = [];
    for (const apply of batch.map((pending) => pending())) apply?.();
  });
}

/** CSS chooses where to clip, so floating menus can escape the media surface. */
export function useMediaCorners() {
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    let attached = true;
    const measure: Measure = () => {
      if (!attached) return;
      const { offsetWidth: width, offsetHeight: height } = element;
      if (!width || !height) return;
      const radius = Number.parseFloat(
        getComputedStyle(element).borderTopLeftRadius,
      );
      const path = mediaCornerPath(width, height, radius || 0);
      return () => {
        const clip = `path("${path}")`;
        if (element.style.getPropertyValue("--media-corner-clip") !== clip)
          element.style.setProperty("--media-corner-clip", clip);
        // Set the SVG attribute so the outline does not depend on CSS d support.
        element
          .querySelector("[data-image-outline] path")
          ?.setAttribute("d", path);
        element.dataset.smoothCorners = "";
      };
    };
    measureOnMount(measure);
    const observer = new ResizeObserver(() => measure()?.());
    observer.observe(element);
    return () => {
      attached = false;
      observer.disconnect();
      element.style.removeProperty("--media-corner-clip");
      delete element.dataset.smoothCorners;
    };
  }, []);
}
