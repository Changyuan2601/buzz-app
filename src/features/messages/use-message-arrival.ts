import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import styles from "./Messages.module.css";

/** Fade in newly loaded, visible message bodies after the reader has positioned.
 * Track the data window, not virtual row mounts, so scrolling never replays entry.
 * Outer message boxes stay still for scroll anchors and virtualizer measurements. */
export function useMessageArrival(
  scroller: RefObject<HTMLElement | null>,
  rows: readonly { id: string }[],
  ready = true,
  positioned?: RefObject<boolean>,
) {
  const seen = useRef(new Set<string>());
  const animations = useRef(new Set<Animation>());
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame: number | undefined;
    const arrive = () => {
      if (!ready || (positioned && !positioned.current)) return;
      const previous = seen.current;
      seen.current = new Set(rows.map((row) => row.id));
      if (
        document.documentElement.hasAttribute("data-keyboard-navigation") ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const duration =
        Number.parseFloat(style.getPropertyValue("--duration-fast")) || 120;
      const easing =
        style.getPropertyValue("--easing-enter").trim() ||
        "cubic-bezier(0.23, 1, 0.32, 1)";
      const bodies: HTMLElement[] = [];
      for (const row of element.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      )) {
        const id = row.dataset.messageId;
        if (!id || previous.has(id) || !seen.current.has(id)) continue;
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
        const body = row.querySelector<HTMLElement>(
          `:scope > .${styles.message} > .${styles.messageBody}`,
        );
        if (body?.animate) bodies.push(body);
      }
      // Finish all geometry reads before starting any animation. Interleaving
      // them makes each next row flush styles invalidated by the previous fade.
      for (const body of bodies) {
        const animation = body.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration,
          easing,
        });
        animations.current.add(animation);
        animation.onfinish = () => animations.current.delete(animation);
      }
    };
    // Virtua commits its visible rows after the owner's scroll correction.
    // Let that render finish before consuming the new IDs or sampling geometry.
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(arrive);
    };
    if (positioned) schedule();
    else arrive();
    element.addEventListener("reading-positioned", schedule);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeEventListener("reading-positioned", schedule);
    };
  }, [scroller, rows, ready, positioned]);
  useEffect(() => {
    const running = animations.current;
    return () => {
      for (const animation of running) animation.cancel();
      running.clear();
      seen.current.clear();
    };
  }, []);
}
