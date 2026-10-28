import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Whether a pointer has entered the message around `target`. Hover-only chrome,
 * such as a timestamp's hint, mounts on that first visit: the pointer crosses
 * the message before it can rest on a trigger inside it. Untouched rows keep
 * only their static markup.
 *
 * Mounting replaces the trigger's element, and the replacement's hover
 * listeners attach only after it commits. A pointer whose latest move was over
 * the trigger, such as one entering the message directly over it, is replayed
 * on the mounted trigger, entry first, so resting there still opens the hint.
 */
export function useMessageVisited(
  target: RefObject<HTMLElement | null>,
  defer = true,
) {
  const [visited, setVisited] = useState(!defer);
  const moved = useRef<MouseEvent | undefined>(undefined);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    if (visited) {
      const move = moved.current;
      moved.current = undefined;
      // The replacement's hover state may not be computed yet.
      if (!move) return;
      const at = {
        clientX: move.clientX,
        clientY: move.clientY,
        screenX: move.screenX,
        screenY: move.screenY,
      };
      element.dispatchEvent(new MouseEvent("mouseenter", at));
      element.dispatchEvent(
        new MouseEvent("mousemove", { ...at, bubbles: true, cancelable: true }),
      );
      return;
    }
    const message = element.closest("[data-message-id]");
    if (!message || message.matches(":hover")) {
      setVisited(true);
      return;
    }
    const visit = () => setVisited(true);
    // The message outlives the static trigger: hear moves over either element,
    // keeping only a pointer whose latest move is still over the trigger.
    const move = (event: MouseEvent) => {
      moved.current =
        event.target instanceof Node && target.current?.contains(event.target)
          ? event
          : undefined;
    };
    const leave = () => {
      moved.current = undefined;
    };
    message.addEventListener("pointerenter", visit);
    message.addEventListener("mousemove", move, true);
    message.addEventListener("mouseleave", leave);
    return () => {
      message.removeEventListener("pointerenter", visit);
      message.removeEventListener("mousemove", move, true);
      message.removeEventListener("mouseleave", leave);
    };
  }, [visited, target]);
  return visited;
}
